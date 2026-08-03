/**
 * Explicit sidebar search (/ or Ctrl+K). Scoring from lib/link-search.js.
 * No type-anywhere capture — omnibox is the page-focused launcher.
 */
const Search = () => globalThis.SnLinksLinkSearch;
const { flattenLinkNodes } = globalThis.SnLinksLinkModel;

export function normalizeSearchQuery(raw) {
  return Search().normalizeSearchQuery(raw);
}

export function createSearchController({
  searchInputEl,
  displayLabel,
  getLinkSections,
  getActiveSection,
  setActiveSectionName,
  sectionTabKey,
  renderAll,
}) {
  let searchQuery = "";

  function nodeSearchScore(node, query) {
    return Search().nodeSearchScore(node, query);
  }

  function nodeHasExactSearchMatch(node, query) {
    return Search().nodeHasExactSearchMatch(node, query);
  }

  function sectionHasExactMatch(section, query) {
    if (!query) {
      return false;
    }
    return flattenLinkNodes(
      section.children,
      section.match,
      section.name
    ).some((node) => nodeHasExactSearchMatch(node, query));
  }

  function findSectionWithExactMatch(query) {
    const linkSections = getLinkSections();
    if (!query || !linkSections) {
      return null;
    }
    return (
      linkSections.find((section) => sectionHasExactMatch(section, query))
        ?.name ?? null
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

  function isEditableElement(element) {
    if (!element) {
      return false;
    }
    const tag = element.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      return true;
    }
    if (element.isContentEditable) {
      return true;
    }
    return Boolean(element.closest?.(".cm-editor"));
  }

  function focusSearchInput() {
    if (!searchInputEl) {
      return;
    }
    searchInputEl.focus();
    const length = searchInputEl.value.length;
    searchInputEl.setSelectionRange(length, length);
  }

  async function applySearchQueryChange() {
    await maybeSwitchSectionForExactMatch();
    await renderAll();
  }

  async function clearSearch() {
    searchQuery = "";
    if (searchInputEl) {
      searchInputEl.value = "";
    }
    await renderAll();
  }

  function initSearch() {
    if (!searchInputEl) {
      return;
    }

    searchInputEl.addEventListener("input", async () => {
      searchQuery = searchInputEl.value;
      await applySearchQueryChange();
    });

    searchInputEl.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void (async () => {
          await clearSearch();
          searchInputEl.blur();
        })();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (isEditableElement(document.activeElement) && document.activeElement !== searchInputEl) {
        return;
      }

      const isFindShortcut =
        (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey) ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k");

      if (isFindShortcut) {
        if (document.activeElement === searchInputEl && event.key === "/") {
          return;
        }
        event.preventDefault();
        focusSearchInput();
        return;
      }

      if (event.key === "Escape" && document.activeElement === searchInputEl) {
        event.preventDefault();
        void (async () => {
          await clearSearch();
          searchInputEl.blur();
        })();
      }
    });
  }

  function getSearchQuery() {
    return searchQuery;
  }

  function setSearchQuery(value) {
    searchQuery = value || "";
    if (searchInputEl) {
      searchInputEl.value = searchQuery;
    }
  }

  return {
    initSearch,
    getSearchQuery,
    setSearchQuery,
    normalizeSearchQuery,
    sectionHasExactMatch,
    maybeSwitchSectionForExactMatch,
    sortNodesBySearchScore,
    getSearchRowHighlight,
    getScriptSearchRowHighlight: getSearchRowHighlight,
    nodeSearchScore,
    focusSearchInput,
    clearSearch,
  };
}
