import { getActiveTab } from "./tab-target.js";

const { flattenLinkNodes } = globalThis.SnLinksLinkModel;

export function normalizeSearchQuery(raw) {
  return raw.trim().toLowerCase();
}

export function isExactSearchMatch(label, query) {
  return Boolean(query) && label.toLowerCase() === query;
}

export function searchMatchScore(label, query) {
  if (!query) {
    return 1;
  }

  const normalizedLabel = label.toLowerCase();
  if (normalizedLabel === query) {
    return 1000;
  }
  if (normalizedLabel.startsWith(query)) {
    return 500 + Math.max(0, 100 - query.length);
  }

  const index = normalizedLabel.indexOf(query);
  if (index === -1) {
    return 0;
  }

  return 200 - index;
}

export function createSearchController({
  searchOverlayEl,
  searchInputEl,
  displayLabel,
  getLinkSections,
  getActiveSection,
  setActiveSectionName,
  sectionTabKey,
  renderAll,
}) {
  let searchQuery = "";
  let searchOverlayPageTabId = null;
  let searchUsesPageOverlay = true;

  function getSearchTags(node) {
    if (!Array.isArray(node.searchTags)) {
      return [];
    }

    return node.searchTags
      .filter((tag) => typeof tag === "string")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  function nodeSearchScore(node, query) {
    if (!query) {
      return 1;
    }

    let score = searchMatchScore(displayLabel(node), query);
    for (const tag of getSearchTags(node)) {
      score = Math.max(score, searchMatchScore(tag, query));
    }
    return score;
  }

  function nodeHasExactSearchMatch(node, query) {
    if (!query) {
      return false;
    }

    if (isExactSearchMatch(displayLabel(node), query)) {
      return true;
    }

    return getSearchTags(node).some((tag) => isExactSearchMatch(tag, query));
  }

  function sectionHasExactMatch(section, query) {
    if (!query) {
      return false;
    }

    return flattenLinkNodes(
      section.children,
      section.hostPattern,
      section.name
    ).some((node) => nodeHasExactSearchMatch(node, query));
  }

  function findSectionWithExactMatch(query) {
    const linkSections = getLinkSections();
    if (!query || !linkSections) {
      return null;
    }

    return (
      linkSections.find((section) => sectionHasExactMatch(section, query))?.name ??
      null
    );
  }

  function currentViewHasExactMatch(query) {
    const section = getActiveSection();
    return Boolean(section && sectionHasExactMatch(section, query));
  }

  async function maybeSwitchSectionForExactMatch() {
    const query = normalizeSearchQuery(searchQuery);
    if (!query || currentViewHasExactMatch(query)) {
      return false;
    }

    const sectionName = findSectionWithExactMatch(query);
    const activeSection = getActiveSection();
    if (!sectionName || sectionName === activeSection?.name) {
      return false;
    }

    setActiveSectionName(sectionName);
    await browser.storage.local.set({ [sectionTabKey]: sectionName });
    return true;
  }

  function sortNodesBySearchScore(nodes, getScore) {
    const query = normalizeSearchQuery(searchQuery);
    if (!query) {
      return nodes;
    }

    return [...nodes]
      .map((node) => ({
        node,
        score: getScore(node, query),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          displayLabel(a.node).localeCompare(displayLabel(b.node))
      )
      .map((entry) => entry.node);
  }

  function getSearchRowHighlight(node, query) {
    if (!query || nodeSearchScore(node, query) <= 0) {
      return {};
    }

    return {
      searchMatch: true,
      searchExactMatch: nodeHasExactSearchMatch(node, query),
    };
  }

  function getScriptSearchRowHighlight(node, query) {
    return getSearchRowHighlight(node, query);
  }

  function focusSearchInput() {
    if (!searchInputEl) {
      return;
    }

    searchInputEl.focus();
    const length = searchInputEl.value.length;
    searchInputEl.setSelectionRange(length, length);
  }

  function setSearchOverlayFallback(usesFallback) {
    if (!searchOverlayEl) {
      return;
    }

    searchOverlayEl.classList.toggle("search-overlay-fallback", usesFallback);
  }

  async function syncPageSearchOverlay(visible, text) {
    if (!searchUsesPageOverlay) {
      return;
    }

    const tab = await getActiveTab();
    const injectable =
      tab?.id != null && typeof tab.url === "string" && /^https?:\/\//i.test(tab.url);

    if (!injectable) {
      searchUsesPageOverlay = false;
      return;
    }

    try {
      if (searchOverlayPageTabId !== tab.id) {
        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["lib/search-overlay-page.js"],
        });
        searchOverlayPageTabId = tab.id;
      }

      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: (show, queryText) => {
          globalThis.__snLinksSyncSearchOverlay?.(show, queryText);
        },
        args: [visible, text],
      });
    } catch {
      searchUsesPageOverlay = false;
    }
  }

  async function setSearchOverlayVisible(visible) {
    if (!searchOverlayEl || !searchInputEl) {
      return;
    }

    searchOverlayEl.classList.toggle("hidden", !visible);
    searchOverlayEl.setAttribute("aria-hidden", visible ? "false" : "true");

    if (visible) {
      // Keep the popup input visible; page overlay is a mirror only (often hidden behind the popup).
      setSearchOverlayFallback(true);
      focusSearchInput();
      await syncPageSearchOverlay(true, searchInputEl.value);
      return;
    }

    setSearchOverlayFallback(false);
    await syncPageSearchOverlay(false, "");
    searchOverlayPageTabId = null;
  }

  async function applySearchQueryChange() {
    await maybeSwitchSectionForExactMatch();
    await renderAll();
  }

  async function closeSearch() {
    searchQuery = "";
    if (searchInputEl) {
      searchInputEl.value = "";
    }
    await setSearchOverlayVisible(false);
    await renderAll();
  }

  async function openSearch(initialValue = "") {
    searchQuery = initialValue;
    if (searchInputEl) {
      searchInputEl.value = initialValue;
    }
    await setSearchOverlayVisible(true);
    await applySearchQueryChange();
    focusSearchInput();
  }

  function isEditableElement(element) {
    if (!element) {
      return false;
    }

    const tag = element.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      return true;
    }

    return element.isContentEditable;
  }

  function shouldIgnoreSearchKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return true;
    }

    if (event.key === "Tab" || event.key === "Enter") {
      return true;
    }

    return false;
  }

  function initSearch() {
    if (!searchOverlayEl || !searchInputEl) {
      return;
    }

    searchInputEl.addEventListener("input", async () => {
      searchQuery = searchInputEl.value;
      if (!searchQuery) {
        await closeSearch();
        return;
      }
      await syncPageSearchOverlay(true, searchQuery);
      await applySearchQueryChange();
      focusSearchInput();
    });

    searchInputEl.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        void closeSearch();
      }
    });

    window.addEventListener("pagehide", () => {
      void syncPageSearchOverlay(false, "");
    });

    document.addEventListener("keydown", (event) => {
      if (shouldIgnoreSearchKey(event)) {
        if (event.key === "Escape" && !searchOverlayEl.classList.contains("hidden")) {
          event.preventDefault();
          void closeSearch();
        }
        return;
      }

      if (
        !searchOverlayEl.classList.contains("hidden") &&
        document.activeElement === searchInputEl
      ) {
        return;
      }

      if (isEditableElement(document.activeElement)) {
        return;
      }

      if (event.key === "Escape") {
        return;
      }

      if (event.key === "Backspace") {
        if (searchOverlayEl.classList.contains("hidden")) {
          return;
        }
        event.preventDefault();
        void (async () => {
          const nextValue = searchQuery.slice(0, -1);
          if (!nextValue) {
            await closeSearch();
            return;
          }
          await openSearch(nextValue);
        })();
        return;
      }

      if (event.key.length !== 1) {
        return;
      }

      event.preventDefault();
      void openSearch(searchQuery + event.key);
    });
  }

  function getSearchQuery() {
    return searchQuery;
  }

  return {
    initSearch,
    getSearchQuery,
    normalizeSearchQuery,
    sectionHasExactMatch,
    maybeSwitchSectionForExactMatch,
    sortNodesBySearchScore,
    getSearchRowHighlight,
    getScriptSearchRowHighlight,
    nodeSearchScore,
  };
}
