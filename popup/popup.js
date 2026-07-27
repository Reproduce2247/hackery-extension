import { getActiveTab } from "./tab-target.js";
import { createActivateLink, loadParamValues } from "./activate-link.js";
import { createSearchController, searchMatchScore } from "./search.js";
import {
  handleDocumentClickForCombobox,
  createLinkUi,
  loadCustomScripts,
  loadInjectOnLoad,
  saveCustomScripts,
  setInjectOnLoad,
} from "./link-ui.js";

if (!globalThis.SnLinksLinkModel) {
  throw new Error("sn-links: lib/link-model.js must load before popup.js");
}

const { parseLinkSections, normalizeScriptInput, defaultScriptName, flattenLinkNodes } =
  globalThis.SnLinksLinkModel;

const SECTION_TAB_KEY = "activeSectionTab";
const ADD_SCRIPT_EXPANDED_KEY = "addScriptExpanded";
const POPUP_SIZE_KEY = "popupSize";
const POPUP_MIN_WIDTH = 420;
const POPUP_MIN_HEIGHT = 400;
const POPUP_MAX_WIDTH = 800;
const POPUP_MAX_HEIGHT = 600;
const POPUP_DEFAULT_WIDTH = 420;
const POPUP_DEFAULT_HEIGHT = 560;

const sectionTabsEl = document.getElementById("section-tabs");
const linksEl = document.getElementById("links");
const instanceStatusEl = document.getElementById("instance-status");
const cspDisableLabel = document.getElementById("csp-disable-label");
const cspDisableCheckbox = document.getElementById("csp-disable-checkbox");
const injectOnLoadEnabledEl = document.getElementById("inject-on-load-enabled");
const networkHooksEnabledEl = document.getElementById("network-hooks-enabled");
const messageEl = document.getElementById("message");
const scriptNameInput = document.getElementById("script-name");
const scriptCodeInput = document.getElementById("script-code");
const addScriptBtn = document.getElementById("add-script-btn");
const addScriptSection = document.querySelector(".add-script");
const addScriptToggle = document.getElementById("add-script-toggle");
const addScriptPanel = document.getElementById("add-script-panel");
const searchOverlayEl = document.getElementById("search-overlay");
const searchInputEl = document.getElementById("search-input");

let linkSections = null;
let activeSectionName = null;

function showMessage(text) {
  messageEl.textContent = text;
  messageEl.classList.remove("hidden");
}

function hideMessage() {
  messageEl.classList.add("hidden");
}

const activateLink = createActivateLink({ showMessage, hideMessage });
const linkUi = createLinkUi({ activateLink, setInjectOnLoad });

function getLinkSections() {
  return linkSections;
}

function getActiveSection() {
  return linkSections?.find((section) => section.name === activeSectionName) || null;
}

function setActiveSectionName(name) {
  activeSectionName = name;
}

function renderSectionTabs() {
  if (!sectionTabsEl || !linkSections) {
    return;
  }

  const query = search.normalizeSearchQuery(search.getSearchQuery());
  sectionTabsEl.replaceChildren();
  for (const section of linkSections) {
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
    linksEl.replaceChildren();
    const savedParamValues = await loadParamValues();
    const injectOnLoad = await loadInjectOnLoad();
    const customScripts = await loadCustomScripts();
    const showRemove = customScripts.length > 0;
    const section = getActiveSection();
    const showParams =
      customScripts.some((script) =>
        linkUi.nodeHasParams({
          type: "scriptlet",
          code: script.code,
          parameter: script.parameter,
          parameters: script.parameters,
        })
      ) || (section ? linkUi.treeHasParams(section.children) : false);
    const showOnLoad =
      customScripts.some((script) =>
        globalThis.SnLinksLinkModel.nodeHasOnLoad({
          type: "scriptlet",
          code: script.code,
        })
      ) || (section ? linkUi.treeHasOnLoad(section.children) : false);
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
          flattenLinkNodes(section.children, section.hostPattern, section.name),
          (node, activeQuery) => search.nodeSearchScore(node, activeQuery)
        );
        for (const node of sortedNodes) {
          list.appendChild(
            linkUi.createLinkRow(node, {
              savedParamValues,
              injectOnLoad,
              showRemove,
              ...search.getSearchRowHighlight(node, query),
            })
          );
        }
      } else {
        linkUi.renderNodes(
          section.children,
          list,
          savedParamValues,
          section.hostPattern,
          section.name,
          injectOnLoad,
          { showRemove }
        );
      }
    }

    linkUi.renderCustomScripts(
      customScripts,
      list,
      savedParamValues,
      injectOnLoad,
      query,
      {
        sortNodesBySearchScore: search.sortNodesBySearchScore,
        getScriptSearchRowHighlight: search.getScriptSearchRowHighlight,
        searchMatchScore,
        onDeleteScript: async (scriptId) => {
          const scripts = await loadCustomScripts();
          const nextScripts = scripts.filter((item) => item.id !== scriptId);
          await saveCustomScripts(nextScripts);
          const nextInject = await loadInjectOnLoad();
          delete nextInject[scriptId];
          await browser.storage.local.set({
            [globalThis.SnLinksLinkModel.INJECT_ON_LOAD_KEY]: nextInject,
          });
          await renderAll();
        },
      }
    );

    linksEl.appendChild(list);
    renderSectionTabs();
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
  loadCustomScripts,
  renderAll,
});

async function addCustomScript() {
  hideMessage();

  const code = normalizeScriptInput(scriptCodeInput.value);
  if (!code) {
    showMessage("Paste a script before adding an action.");
    scriptCodeInput.focus();
    return;
  }

  const scripts = await loadCustomScripts();
  const name = scriptNameInput.value.trim() || defaultScriptName(code, scripts);
  const nextScripts = scripts.concat({
    id: crypto.randomUUID(),
    name,
    code,
    createdAt: Date.now(),
  });

  await saveCustomScripts(nextScripts);
  scriptNameInput.value = "";
  scriptCodeInput.value = "";
  await renderAll();
  showMessage(`Added "${name}".`);
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

async function openNetworkRulesWindow() {
  const rulesUrl = browser.runtime.getURL("rules/rules.html");
  const windows = await browser.windows.getAll({ populate: true });
  for (const win of windows) {
    for (const tab of win.tabs || []) {
      if (tab.url === rulesUrl && win.id != null) {
        await browser.windows.update(win.id, { focused: true });
        if (tab.id != null) {
          await browser.tabs.update(tab.id, { active: true });
        }
        return;
      }
    }
  }

  await browser.windows.create({
    url: rulesUrl,
    type: "popup",
    width: 960,
    height: 760,
  });
}

async function init() {
  const raw = await fetch(browser.runtime.getURL("data/links.json")).then(
    (response) => response.json()
  );
  linkSections = parseLinkSections(raw);
  const stored = await browser.storage.local.get(SECTION_TAB_KEY);
  activeSectionName =
    stored[SECTION_TAB_KEY] ||
    linkSections.find((section) => section.name === "ServiceNow")?.name ||
    linkSections[0]?.name ||
    null;

  const activeTab = await getActiveTab();
  if (activeTab?.url) {
    instanceStatusEl.textContent = `Active tab: ${new URL(activeTab.url).origin}`;
  } else {
    instanceStatusEl.textContent = "No active tab";
  }

  addScriptBtn.addEventListener("click", () => {
    addCustomScript();
  });

  const networkRulesBtn = document.getElementById("network-rules-btn");
  if (networkRulesBtn) {
    networkRulesBtn.addEventListener("click", () => {
      openNetworkRulesWindow();
    });
  }

  document.addEventListener("click", handleDocumentClickForCombobox);

  scriptCodeInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      addCustomScript();
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
