import { clearTabFlags, refresh as refreshBadge } from "./lib/action-badge.js";
import { activateLinkNode } from "./lib/activate-link.js";
import { createBackgroundMessageHandlers } from "./lib/background-messages.js";
import { appendMissingKeys, applyOrder, loadCatalogOrder } from "./lib/catalog-order.js";
import { CATALOG_CHANGED, isCatalogChangedMessage } from "./lib/catalog-events.js";
import { initCspDisable, isCspDisabledForTab, setCspDisabledForTab } from "./lib/csp-disable.js";
import { ensureLinksOverlayInStorage, mergeLinksCatalog } from "./lib/link-catalog.js";
import { collectScriptlets, getParameterDefs, matchesHostPattern, resolveParamValues } from "./lib/link-model.js";
import { searchCatalog } from "./lib/link-search.js";
import { findNodeByStableKey, isSlotCommand, loadShortcutSlots } from "./lib/link-shortcuts.js";
import { createMessageRouter } from "./lib/message-router.js";
import { MessageTypes, MessageTypeSet } from "./lib/message-types.js";
import { executeScriptletWithBindings } from "./lib/scriptlet-inject.js";
import { StorageKeys } from "./lib/storage-keys.js";
import { canonicalizeHref } from "./lib/url-normalize.js";
import { NetworkMessageTypeSet } from "./network/message-types.js";
import * as Network from "./network/plugin.js";

const {
  INJECT_ON_LOAD_ENABLED_KEY,
  INJECT_ON_LOAD_KEY,
  PARAM_VALUES_KEY,
  LINKS_OVERLAY_KEY,
  CUSTOM_SCRIPTS_KEY,
  CATALOG_ORDER_KEY,
  LINK_SHORTCUT_SLOTS_KEY,
  LINK_BUILDER_PREFILL_KEY,
} = StorageKeys;

const HTTP_CONTENT_SCRIPT_MATCHES = ["http://*/*", "https://*/*"];

const INJECT_SCRIPT_ID = "complex-linker-on-load";
const CONTEXT_TARGET_SCRIPT_ID = "complex-linker-context-target";
const REFRESH_DEBOUNCE_MS = 300;

let linksCache = null;
/** @type {{ match: string | null, code: string, paramValues: Record<string, string> }[]} */
let injectEntries = [];
let extensionSettings = { injectOnLoadEnabled: true };
let injectRefreshTimer = null;

async function getLinkSections() {
  if (!linksCache) {
    const response = await fetch(browser.runtime.getURL("data/links.json"));
    const bundled = await response.json();
    const overlay = await ensureLinksOverlayInStorage();
    linksCache = mergeLinksCatalog(bundled, overlay);
  }
  return linksCache;
}

function codesForUrl(url) {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return [];
  }

  return injectEntries.filter((entry) => matchesHostPattern(url, entry.match));
}

async function runInjectEntriesForTab(tabId, entries, frameId) {
  for (const entry of entries) {
    await executeScriptletInTab(tabId, entry.code, entry.paramValues, frameId);
  }
}

async function loadHostSettings() {
  const stored = await browser.storage.local.get([INJECT_ON_LOAD_ENABLED_KEY]);
  extensionSettings = {
    injectOnLoadEnabled: stored[INJECT_ON_LOAD_ENABLED_KEY] !== false,
  };
  return extensionSettings;
}

async function loadExtensionSettings() {
  const host = await loadHostSettings();
  const network = (await Network.getSettingsFragment()) || {};
  return { ...host, ...network };
}

async function rebuildInjectCache() {
  const stored = await browser.storage.local.get([
    INJECT_ON_LOAD_KEY,
    PARAM_VALUES_KEY,
  ]);
  const injectOnLoad = stored[INJECT_ON_LOAD_KEY] || {};
  const paramValues = stored[PARAM_VALUES_KEY] || {};
  const sections = await getLinkSections();
  const scriptlets = [];

  for (const [name, section] of Object.entries(sections)) {
    collectScriptlets(
      section.children || [],
      section.match ?? section.hostPattern ?? null,
      name,
      scriptlets
    );
  }

  injectEntries = [];
  for (const { linkKey, node } of scriptlets) {
    if (!injectOnLoad[linkKey]) continue;

    const parameterDefs = getParameterDefs(node);
    const rawValues = paramValues[linkKey] || {};
    const values = resolveParamValues(parameterDefs, rawValues);
    injectEntries.push({
      match: node.match ?? null,
      code: node.code,
      paramValues: values,
    });
  }
}

async function syncInjectRegistration() {
  try {
    await browser.scripting.unregisterContentScripts({ ids: [INJECT_SCRIPT_ID] });
  } catch {
    // not registered yet
  }

  if (!extensionSettings.injectOnLoadEnabled || injectEntries.length === 0) {
    return;
  }

  await browser.scripting.registerContentScripts([
    {
      id: INJECT_SCRIPT_ID,
      matches: HTTP_CONTENT_SCRIPT_MATCHES,
      runAt: "document_start",
      allFrames: true,
      js: ["inject/on-load.js"],
    },
  ]);
}

/**
 * Keep context-target.js resident so contextmenu fires into an already-listening script.
 * Late injection on menu click misses the event that just opened the menu.
 */
async function syncContextTargetRegistration() {
  try {
    await browser.scripting.unregisterContentScripts({
      ids: [CONTEXT_TARGET_SCRIPT_ID],
    });
  } catch {
    // not registered yet
  }

  await browser.scripting.registerContentScripts([
    {
      id: CONTEXT_TARGET_SCRIPT_ID,
      matches: HTTP_CONTENT_SCRIPT_MATCHES,
      runAt: "document_start",
      allFrames: true,
      js: ["inject/context-target.js"],
    },
  ]);
}

async function injectContextTargetAllTabs() {
  const tabs = await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (!tab.id) {
      continue;
    }
    try {
      await browser.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ["inject/context-target.js"],
      });
    } catch {
      // restricted tab — skip
    }
  }
}

async function reinjectOnLoadAllTabs() {
  if (!extensionSettings.injectOnLoadEnabled || injectEntries.length === 0) {
    return;
  }

  const tabs = await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (!tab.id || !tab.url) {
      continue;
    }
    const codes = codesForUrl(tab.url);
    if (!codes.length) {
      continue;
    }
    try {
      await runInjectEntriesForTab(tab.id, codes);
    } catch {
      // restricted tab — skip
    }
  }
}

async function refreshInjectState() {
  await loadHostSettings();
  await rebuildInjectCache();
  await syncInjectRegistration();
  await reinjectOnLoadAllTabs();
}

async function executeScriptletInTab(tabId, code, paramValues = {}, frameId) {
  return executeScriptletWithBindings(tabId, code, paramValues, { frameId });
}

function scheduleRefreshInjectState() {
  clearTimeout(injectRefreshTimer);
  injectRefreshTimer = setTimeout(() => {
    refreshInjectState().catch(() => {});
  }, REFRESH_DEBOUNCE_MS);
}

async function refreshActionBadge(tabId, url) {
  if (!tabId) {
    return;
  }
  const settings = await loadExtensionSettings();
  const networkMark =
    settings.networkHooksEnabled !== false ? Network.getBadgeMark(tabId) : "";
  let injectMark = "";
  if (settings.injectOnLoadEnabled && url && codesForUrl(url).length) {
    injectMark = "+";
  }
  await refreshBadge(tabId, {
    network: networkMark,
    inject: injectMark,
  });
}

function scheduleActiveTabBadgeRefresh() {
  void browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    const tab = tabs[0];
    if (tab) {
      refreshActionBadge(tab.id, tab.url);
    }
  });
}

async function initExtension({ clearLinksCache = false } = {}) {
  if (clearLinksCache) {
    linksCache = null;
  }
  initCspDisable();
  await Promise.all([
    refreshInjectState(),
    syncContextTargetRegistration()
      .then(() => injectContextTargetAllTabs())
      .catch((error) => {
        console.error("context-target registration failed:", error);
      }),
    Network.init({
      onRulesChanged(tabId) {
        if (tabId != null) {
          void browser.tabs.get(tabId).then((tab) => {
            refreshActionBadge(tab.id, tab.url);
          }).catch(() => {});
          return;
        }
        scheduleActiveTabBadgeRefresh();
      },
    }),
  ]);
}

const messageHandlers = {
  ...createBackgroundMessageHandlers({
    INJECT_ON_LOAD_ENABLED_KEY,
    extensionSettings: () => extensionSettings,
    codesForUrl,
    runInjectEntriesForTab,
    executeScriptletInTab,
    refreshInjectState,
    loadExtensionSettings,
    isCspDisabledForTab,
    setCspDisabledForTab,
    collectNetworkSettingsPayload: (next) => Network.collectSettingsPayload(next),
  }),
  ...Network.createMessageHandlers(),
};

const knownMessageTypes = new Set([
  ...MessageTypeSet,
  ...NetworkMessageTypeSet,
  CATALOG_CHANGED,
]);

browser.runtime.onMessage.addListener(
  createMessageRouter(messageHandlers, { knownTypes: knownMessageTypes })
);

browser.storage.onChanged.addListener((changes, area) => {
  Network.handleStorageChange(changes, area);
  if (area === "local") {
    if (
      changes[INJECT_ON_LOAD_KEY] ||
      changes[PARAM_VALUES_KEY] ||
      changes[LINKS_OVERLAY_KEY] ||
      changes[CUSTOM_SCRIPTS_KEY] ||
      changes[INJECT_ON_LOAD_ENABLED_KEY]
    ) {
      if (changes[LINKS_OVERLAY_KEY] || changes[CUSTOM_SCRIPTS_KEY]) {
        linksCache = null;
      }
      scheduleRefreshInjectState();
    }
    if (changes[INJECT_ON_LOAD_ENABLED_KEY]) {
      loadHostSettings();
    }
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  Network.handleTabRemoved(tabId);
  clearTabFlags(tabId);
  void refreshBadge(tabId, {});
});

browser.runtime.onInstalled.addListener(() => {
  initExtension({ clearLinksCache: true });
  initContextMenus();
});

browser.runtime.onStartup.addListener(() => {
  initExtension();
});

initExtension();
initContextMenus();

// --- Sidebar toggle, omnibox, shortcuts, context menus, badges ---

async function getOrderedCatalog() {
  const catalog = await getLinkSections();
  const order = await loadCatalogOrder();
  const next = appendMissingKeys(order, catalog);
  return applyOrder(catalog, next);
}

async function openSidebarPanel() {
  try {
    await browser.sidebarAction.open();
  } catch {
    // Some hosts disallow open(); toggle may still work from user gesture.
  }
}

async function toggleSidebarPanel() {
  try {
    if (browser.sidebarAction.toggle) {
      await browser.sidebarAction.toggle();
      return;
    }
  } catch {
    // fall through
  }
  await openSidebarPanel();
}

browser.action.onClicked.addListener(() => {
  void toggleSidebarPanel();
});

async function activateByStableKey(stableKey, { openSidebarIfNeeded = true } = {}) {
  const catalog = await getOrderedCatalog();
  const node = findNodeByStableKey(catalog, stableKey);
  if (!node) {
    await browser.action.setBadgeText({ text: "?" });
    setTimeout(() => browser.action.setBadgeText({ text: "" }), 1200);
    return { ok: false, message: "Link not found." };
  }

  const outcome = await activateLinkNode(node, {
    allowMissingParams: false,
  });

  if (outcome.needsParams && openSidebarIfNeeded) {
    const label = node.displayName || node.name;
    await openSidebarPanel();
    browser.runtime
      .sendMessage({
        type: MessageTypes.FOCUS_SIDEBAR_LINK,
        stableKey,
        query: label,
      })
      .catch(() => {});
    return outcome;
  }

  if (!outcome.ok) {
    await browser.action.setBadgeText({ text: "!" });
    setTimeout(() => browser.action.setBadgeText({ text: "" }), 1200);
  }
  return outcome;
}

browser.commands.onCommand.addListener((command) => {
  if (command === "_execute_sidebar_action") {
    void toggleSidebarPanel();
    return;
  }
  if (!isSlotCommand(command)) {
    return;
  }
  void (async () => {
    const slots = await loadShortcutSlots();
    const key = slots[command];
    if (!key) {
      await browser.action.setBadgeText({ text: "—" });
      setTimeout(() => browser.action.setBadgeText({ text: "" }), 1000);
      return;
    }
    await activateByStableKey(key);
  })();
});

let omniboxCatalogCache = null;
let omniboxCacheAt = 0;

async function getOmniboxCatalog() {
  if (omniboxCatalogCache && Date.now() - omniboxCacheAt < 5000) {
    return omniboxCatalogCache;
  }
  try {
    omniboxCatalogCache = await getOrderedCatalog();
  } catch (error) {
    console.error("ordered catalog failed, using raw merge:", error);
    omniboxCatalogCache = await getLinkSections();
  }
  omniboxCacheAt = Date.now();
  return omniboxCatalogCache;
}

function escapeOmniboxXml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

browser.omnibox.setDefaultSuggestion({
  description: "Search Complex Linker actions (Enter to run top match)",
});

browser.omnibox.onInputChanged.addListener((text, suggest) => {
  void (async () => {
    try {
      const catalog = await getOmniboxCatalog();
      const matches = searchCatalog(catalog, text, 8);
      suggest(
        matches.map((entry) => {
          const label = entry.label || "";
          const section = entry.node.sectionName || "";
          const safeLabel = escapeOmniboxXml(label);
          const safeSection = escapeOmniboxXml(section);
          return {
            content: label,
            description: safeSection
              ? `${safeLabel} — ${safeSection}`
              : safeLabel,
          };
        })
      );
    } catch (error) {
      console.error("omnibox search failed:", error);
      suggest([]);
    }
  })();
});

browser.omnibox.onInputEntered.addListener((text) => {
  void (async () => {
    try {
      const catalog = await getOmniboxCatalog();
      const matches = searchCatalog(catalog, text, 1);
      const top = matches[0];
      if (!top?.key) {
        return;
      }
      await activateByStableKey(top.key);
    } catch (error) {
      console.error("omnibox activate failed:", error);
    }
  })();
});

async function ensureContextTargetScript(tabId, frameId) {
  try {
    const target = { tabId };
    if (typeof frameId === "number") {
      target.frameIds = [frameId];
    } else {
      target.allFrames = true;
    }
    await browser.scripting.executeScript({
      target,
      files: ["inject/context-target.js"],
    });
  } catch {
    // Restricted pages
  }
}

async function openBuilderWithContextPrefill(info, tab) {
  let selector = "";
  let text = "";
  if (tab?.id) {
    await ensureContextTargetScript(tab.id, info.frameId);
    try {
      const options =
        typeof info.frameId === "number" ? { frameId: info.frameId } : undefined;
      const response = await browser.tabs.sendMessage(
        tab.id,
        { type: MessageTypes.GET_CONTEXT_TARGET },
        options
      );
      selector = response?.selector || "";
      text = response?.text || "";
    } catch {
      // no content script response
    }
  }

  const pageUrl = info.pageUrl || tab?.url || "";
  const linkUrl = info.linkUrl || "";
  let match = null;
  let name = text || tab?.title || "New action";
  try {
    if (pageUrl) {
      const host = new URL(pageUrl).hostname.replace(/\./g, "\\.");
      match = `^${host}$`;
    }
  } catch {
    // ignore
  }

  const prefill = {
    name: String(name).slice(0, 80),
    displayName: "",
    absoluteUrl: linkUrl || pageUrl,
    path: "",
    match,
    fromSelector: selector || null,
    builderType: selector ? "derived-url" : "navigate",
    selectionText: info.selectionText || "",
  };

  if (pageUrl) {
    prefill.absoluteUrl = canonicalizeHref(linkUrl || pageUrl);
  }

  await browser.storage.session.set({ [LINK_BUILDER_PREFILL_KEY]: prefill });

  const baseUrl = browser.runtime.getURL("builder/builder.html");
  const targetUrl = `${baseUrl}?new=1`;
  await browser.windows.create({
    url: targetUrl,
    type: "popup",
    width: 960,
    height: 720,
  });
}

function initContextMenus() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({
      id: "cl-create-action",
      title: "Create Complex Linker action",
      contexts: ["page", "link", "selection", "editable"],
    });
  });
}

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "cl-create-action") {
    void openBuilderWithContextPrefill(info, tab);
  }
});

browser.tabs.onActivated.addListener((activeInfo) => {
  void browser.tabs.get(activeInfo.tabId).then((tab) => {
    refreshActionBadge(tab.id, tab.url);
  });
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    void refreshActionBadge(tabId, tab.url);
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (isCatalogChangedMessage(message)) {
    linksCache = null;
    omniboxCatalogCache = null;
    scheduleRefreshInjectState();
    scheduleActiveTabBadgeRefresh();
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes[CATALOG_ORDER_KEY] || changes[LINK_SHORTCUT_SLOTS_KEY])) {
    linksCache = null;
    omniboxCatalogCache = null;
  }
});
