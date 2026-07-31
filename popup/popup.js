import { getActiveTab } from "./tab-target.js";
import { createActivateLink, loadParamValues } from "./activate-link.js";
import { createCopyLink } from "./copy-link.js";
import { createSearchController } from "./search.js";
import {
  handleDocumentClickForCombobox,
  closeOpenContextMenu,
  createLinkUi,
  loadInjectOnLoad,
  setInjectOnLoad,
} from "./link-ui.js";
import {
  loadMergedLinkCatalog,
  addLinksToSection,
  removeCustomLinkById,
} from "./link-storage.js";
import { buildQuickLinkNode } from "./link-builder.js";
import { copyLinkNodeJson } from "./link-export.js";
import { openLinkBuilderWindow } from "./open-builder-window.js";
import {
  attachCodeMirror,
  getFieldValue,
  setFieldValue,
  focusField,
} from "../lib/codemirror-fields.bundle.js";

if (!globalThis.SnLinksLinkModel) {
  throw new Error("sn-links: lib/link-model.js must load before popup.js");
}
if (!globalThis.SnLinksLinkCatalog) {
  throw new Error("sn-links: lib/link-catalog.js must load before popup.js");
}

const {
  SECTION_TAB_KEY,
  ADD_SCRIPT_EXPANDED_KEY,
  POPUP_SIZE_KEY,
  LINKS_OVERLAY_KEY,
} = globalThis.SnLinksStorageKeys;

const { parseLinkSections, flattenLinkNodes } = globalThis.SnLinksLinkModel;
const { isCustomLink } = globalThis.SnLinksLinkCatalog;

const POPUP_MIN_WIDTH = 420;
const POPUP_MIN_HEIGHT = 400;
const POPUP_MAX_WIDTH = 800;
const POPUP_MAX_HEIGHT = 600;
const POPUP_DEFAULT_WIDTH = 420;
const POPUP_DEFAULT_HEIGHT = 560;

const sectionTabsEl = document.getElementById("section-tabs");
const linksEl = document.getElementById("links");
const activeTabStatusEl = document.getElementById("active-tab-status");
const cspDisableLabel = document.getElementById("csp-disable-label");
const cspDisableCheckbox = document.getElementById("csp-disable-checkbox");
const injectOnLoadEnabledEl = document.getElementById("inject-on-load-enabled");
const networkHooksEnabledEl = document.getElementById("network-hooks-enabled");
const messageEl = document.getElementById("message");
const addScriptBtn = document.getElementById("add-script-btn");
const linkBuilderBtn = document.getElementById("link-builder-btn");
const addScriptSection = document.querySelector(".add-script");
const addScriptToggle = document.getElementById("add-script-toggle");
const addScriptChevron = document.querySelector(".add-script-chevron");
const addScriptPanel = document.getElementById("add-script-panel");
const scriptNameInput = document.getElementById("script-name");
const scriptCodeInput = document.getElementById("script-code");

const scriptCodeEditor = attachCodeMirror(scriptCodeInput, {
  language: "javascript",
  minHeight: 80,
  placeholder: "Paste JS or a URL/path",
});
scriptCodeEditor.view.dom.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    addQuickAction();
  }
});
const quickAddModeSelect = document.getElementById("quick-add-mode");
const searchOverlayEl = document.getElementById("search-overlay");
const searchInputEl = document.getElementById("search-input");

let linkSections = null;
let activeSectionName = null;

function updateStickyOffsets() {
  const header = document.querySelector("header");
  const root = document.documentElement;
  root.style.setProperty(
    "--sticky-header-height",
    `${header?.offsetHeight ?? 0}px`
  );
}

const { showMessage, hideMessage } = globalThis.createUiMessage(messageEl, {
  onChange: updateStickyOffsets,
});

const activateLink = createActivateLink({ showMessage, hideMessage });
const copyLink = createCopyLink({ showMessage, hideMessage });

async function exportLinkJson(node) {
  hideMessage();
  try {
    await copyLinkNodeJson(node);
    showMessage("Link JSON copied to clipboard.");
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

function editCustomLink(node) {
  openLinkBuilderWindow({ editId: node.id, sectionName: node.sectionName });
}

const linkUi = createLinkUi({
  activateLink,
  copyLink,
  exportLinkJson,
  editCustomLink,
  setInjectOnLoad,
});

function getLinkSections() {
  return getVisibleSections();
}

function getVisibleSections() {
  return linkSections || [];
}

function sectionHasCustomLinks(section) {
  return flattenLinkNodes(section.children, section.match, section.name).some(
    (node) => isCustomLink(node)
  );
}

function getActiveSection() {
  return linkSections?.find((section) => section.name === activeSectionName) || null;
}

function setActiveSectionName(name) {
  activeSectionName = name;
}

async function reloadLinkSections() {
  const merged = await loadMergedLinkCatalog();
  linkSections = parseLinkSections(merged);
}

function renderSectionTabs() {
  if (!sectionTabsEl || !linkSections) {
    return;
  }

  const query = search.normalizeSearchQuery(search.getSearchQuery());
  sectionTabsEl.replaceChildren();
  for (const section of getVisibleSections()) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "section-tab";
    tab.role = "tab";
    tab.textContent = section.name;
    tab.setAttribute(
      "aria-selected",
      section.name === activeSectionName ? "true" : "false"
    );
    tab.classList.toggle("active", section.name === activeSectionName);
    tab.classList.toggle(
      "search-exact-match",
      search.sectionHasExactMatch(section, query)
    );
    tab.addEventListener("click", async () => {
      activeSectionName = section.name;
      await browser.storage.local.set({ [SECTION_TAB_KEY]: activeSectionName });
      await renderAll();
    });
    sectionTabsEl.appendChild(tab);
  }
}

async function renderAll() {
  if (!linksEl) {
    return;
  }

  try {
    await reloadLinkSections();
    linksEl.replaceChildren();
    const savedParamValues = await loadParamValues();
    const injectOnLoad = await loadInjectOnLoad();
    const section = getActiveSection();
    const showRemove = section ? sectionHasCustomLinks(section) : false;
    const showParams = section ? linkUi.treeHasParams(section.children) : false;
    const showOnLoad = section ? linkUi.treeHasOnLoad(section.children) : false;
    const query = search.normalizeSearchQuery(search.getSearchQuery());

    const list = document.createElement("div");
    list.className = "link-list";
    if (query) {
      list.classList.add("is-searching");
    }
    if (showRemove) {
      list.classList.add("has-remove");
    }
    if (showParams) {
      list.classList.add("has-params");
    }
    if (showOnLoad) {
      list.classList.add("has-on-load");
    }
    list.appendChild(linkUi.createLinkListHeader({ showRemove, showParams, showOnLoad }));

    if (section) {
      if (query) {
        const sortedNodes = search.sortNodesBySearchScore(
          flattenLinkNodes(
            section.children,
            section.match,
            section.name
          ),
          (node, activeQuery) => search.nodeSearchScore(node, activeQuery)
        );
        for (const node of sortedNodes) {
          list.appendChild(
            linkUi.createLinkRow(node, {
              savedParamValues,
              injectOnLoad,
              showRemove: showRemove,
              isCustom: isCustomLink(node),
              onDelete:
                isCustomLink(node) && node.id
                  ? async (event) => {
                      event.stopPropagation();
                      await removeCustomLinkById(node.id);
                      const nextInject = await loadInjectOnLoad();
                      delete nextInject[node.id];
                      await browser.storage.local.set({
                        [globalThis.SnLinksLinkModel.INJECT_ON_LOAD_KEY]: nextInject,
                      });
                      await renderAll();
                    }
                  : null,
              ...search.getSearchRowHighlight(node, query),
            })
          );
        }
      } else {
        linkUi.renderNodes(
          section.children,
          list,
          savedParamValues,
          section.match,
          section.name,
          injectOnLoad,
          {
            showRemoveColumn: showRemove,
            onDeleteCustom: async (linkId) => {
              await removeCustomLinkById(linkId);
              const nextInject = await loadInjectOnLoad();
              delete nextInject[linkId];
              await browser.storage.local.set({
                [globalThis.SnLinksLinkModel.INJECT_ON_LOAD_KEY]: nextInject,
              });
              await renderAll();
            },
          }
        );
      }
    }

    linksEl.appendChild(list);
    renderSectionTabs();
    requestAnimationFrame(updateStickyOffsets);
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

const search = createSearchController({
  searchOverlayEl,
  searchInputEl,
  displayLabel: linkUi.displayLabel,
  getLinkSections,
  getActiveSection,
  setActiveSectionName,
  sectionTabKey: SECTION_TAB_KEY,
  renderAll,
});

async function addQuickAction() {
  hideMessage();

  const section = getActiveSection();
  if (!section) {
    showMessage("Select a section tab before adding an action.");
    return;
  }

  try {
    const leafNodes = flattenLinkNodes(
      section.children,
      section.match,
      section.name
    );
    const node = buildQuickLinkNode(
      getFieldValue(scriptCodeInput),
      scriptNameInput.value,
      leafNodes,
      quickAddModeSelect?.value || "link"
    );
    await addLinksToSection(section.name, [node]);
    scriptNameInput.value = "";
    setFieldValue(scriptCodeInput, "");
    await renderAll();
    showMessage(`Added "${node.name}" to ${section.name}.`);
  } catch (error) {
    showMessage(error.message || String(error));
    focusField(scriptCodeInput);
  }
}

let popupResizeObserverPaused = false;
let pendingPopupSize = null;
let lastAppliedPopupSize = null;

function clampPopupSize(width, height) {
  return {
    width: Math.min(POPUP_MAX_WIDTH, Math.max(POPUP_MIN_WIDTH, Math.round(width))),
    height: Math.min(
      POPUP_MAX_HEIGHT,
      Math.max(POPUP_MIN_HEIGHT, Math.round(height))
    ),
  };
}

function applyPopupSize(width, height) {
  const size = clampPopupSize(width, height);
  if (
    lastAppliedPopupSize &&
    lastAppliedPopupSize.width === size.width &&
    lastAppliedPopupSize.height === size.height
  ) {
    return size;
  }
  lastAppliedPopupSize = size;
  const widthPx = `${size.width}px`;
  const heightPx = `${size.height}px`;
  document.documentElement.style.width = widthPx;
  document.documentElement.style.height = heightPx;
  document.body.style.width = widthPx;
  document.body.style.height = heightPx;
  return size;
}

function updateResizePreview(width, height) {
  const size = clampPopupSize(width, height);
  pendingPopupSize = size;
  document.body.dataset.resizePreview = `${size.width} × ${size.height}`;
}

function clearResizePreview() {
  delete document.body.dataset.resizePreview;
  pendingPopupSize = null;
}

async function savePopupSize() {
  await browser.storage.local.set({
    [POPUP_SIZE_KEY]: {
      width: document.body.offsetWidth,
      height: document.body.offsetHeight,
    },
  });
}

function initResizeHandle() {
  const handle = document.getElementById("resize-handle");
  if (!handle) {
    return;
  }

  handle.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    popupResizeObserverPaused = true;
    document.body.classList.add("is-resizing");

    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = document.body.offsetWidth;
    const startHeight = document.body.offsetHeight;

    updateResizePreview(startWidth, startHeight);

    function onMouseMove(moveEvent) {
      updateResizePreview(
        startWidth - (moveEvent.clientX - startX),
        startHeight + (moveEvent.clientY - startY)
      );
    }

    function onMouseUp() {
      popupResizeObserverPaused = false;
      document.body.classList.remove("is-resizing");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);

      const size = pendingPopupSize;
      clearResizePreview();
      if (size) {
        applyPopupSize(size.width, size.height);
      }

      savePopupSize();
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
}

async function initPopupSize() {
  const stored = await browser.storage.local.get(POPUP_SIZE_KEY);
  const size = stored[POPUP_SIZE_KEY];

  const width =
    size?.width >= POPUP_MIN_WIDTH ? size.width : POPUP_DEFAULT_WIDTH;
  const height =
    size?.height >= POPUP_MIN_HEIGHT ? size.height : POPUP_DEFAULT_HEIGHT;

  applyPopupSize(width, height);
  initResizeHandle();

  let saveTimer = null;
  new ResizeObserver(() => {
    updateStickyOffsets();
    if (popupResizeObserverPaused) {
      return;
    }
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(savePopupSize, 200);
  }).observe(document.body);
}

async function initAddScriptCollapse() {
  const stored = await browser.storage.local.get(ADD_SCRIPT_EXPANDED_KEY);
  setAddScriptExpanded(stored[ADD_SCRIPT_EXPANDED_KEY] === true);

  addScriptToggle.addEventListener("click", async () => {
    const expanded = addScriptToggle.getAttribute("aria-expanded") !== "true";
    setAddScriptExpanded(expanded);
    await browser.storage.local.set({ [ADD_SCRIPT_EXPANDED_KEY]: expanded });
  });

  if (addScriptChevron) {
    addScriptChevron.addEventListener("click", () => {
      addScriptToggle.click();
    });
  }
}

function setAddScriptExpanded(expanded) {
  addScriptSection.classList.toggle("is-collapsed", !expanded);
  addScriptToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  addScriptPanel.hidden = !expanded;
}

async function syncCspDisableUi(tab) {
  if (!cspDisableCheckbox || !cspDisableLabel) {
    return;
  }

  const usable =
    tab?.id != null &&
    typeof tab.url === "string" &&
    /^https?:\/\//i.test(tab.url);

  cspDisableCheckbox.disabled = !usable;
  cspDisableLabel.classList.toggle("is-disabled", !usable);

  if (!usable) {
    cspDisableCheckbox.checked = false;
    return;
  }

  const response = await browser.runtime.sendMessage({
    type: "GET_CSP_DISABLED",
    tabId: tab.id,
  });
  cspDisableCheckbox.checked = Boolean(response?.disabled);
}

async function initExtensionSettingsControls() {
  const response = await browser.runtime.sendMessage({
    type: "GET_EXTENSION_SETTINGS",
  });
  const settings = response?.settings || {
    networkHooksEnabled: true,
    injectOnLoadEnabled: true,
  };

  if (injectOnLoadEnabledEl) {
    injectOnLoadEnabledEl.checked = settings.injectOnLoadEnabled !== false;
    injectOnLoadEnabledEl.addEventListener("change", async () => {
      await browser.runtime.sendMessage({
        type: "SET_EXTENSION_SETTINGS",
        settings: { injectOnLoadEnabled: injectOnLoadEnabledEl.checked },
      });
    });
  }

  if (networkHooksEnabledEl) {
    networkHooksEnabledEl.checked = settings.networkHooksEnabled !== false;
    networkHooksEnabledEl.addEventListener("change", async () => {
      await browser.runtime.sendMessage({
        type: "SET_EXTENSION_SETTINGS",
        settings: { networkHooksEnabled: networkHooksEnabledEl.checked },
      });
    });
  }
}

async function initCspDisableControl() {
  if (!cspDisableCheckbox) {
    return;
  }

  const syncFromActiveTab = async () => {
    await syncCspDisableUi(await getActiveTab());
  };

  await syncFromActiveTab();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void syncFromActiveTab();
    }
  });

  cspDisableCheckbox.addEventListener("change", async () => {
    const tab = await getActiveTab();
    if (!tab?.id || cspDisableCheckbox.disabled) {
      return;
    }

    await browser.runtime.sendMessage({
      type: "SET_CSP_DISABLED",
      tabId: tab.id,
      disabled: cspDisableCheckbox.checked,
    });

    if (cspDisableCheckbox.checked) {
      showMessage("CSP disabled for this tab. Reload the page to apply.");
    } else {
      hideMessage();
    }
  });
}

async function init() {
  await reloadLinkSections();
  const stored = await browser.storage.local.get(SECTION_TAB_KEY);
  const visibleSections = getVisibleSections();
  const storedTab = stored[SECTION_TAB_KEY];
  activeSectionName =
    (storedTab && visibleSections.some((section) => section.name === storedTab)
      ? storedTab
      : null) ||
    visibleSections.find((section) => section.name === "Reverse-engineering tools")
      ?.name ||
    visibleSections[0]?.name ||
    null;

  const activeTab = await getActiveTab();
  if (activeTab?.url) {
    activeTabStatusEl.textContent = `Active tab: ${new URL(activeTab.url).origin}`;
  } else {
    activeTabStatusEl.textContent = "No active tab";
  }
  updateStickyOffsets();

  addScriptBtn.addEventListener("click", () => {
    addQuickAction();
  });
  linkBuilderBtn.addEventListener("click", () => {
    openLinkBuilderWindow({ sectionName: activeSectionName });
  });

  document.addEventListener("click", handleDocumentClickForCombobox);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeOpenContextMenu();
    }
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[LINKS_OVERLAY_KEY]) {
      renderAll();
    }
  });

  search.initSearch();
  await initPopupSize();
  await renderAll();
  await initAddScriptCollapse();
  try {
    await initExtensionSettingsControls();
  } catch (error) {
    console.error("Failed to load extension settings:", error);
  }
  try {
    await initCspDisableControl();
  } catch (error) {
    console.error("Failed to init CSP control:", error);
  }
}

init().catch((error) => {
  showMessage(error.message || String(error));
});
