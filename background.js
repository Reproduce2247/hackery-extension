if (!globalThis.SnLinksLinkModel) {
  throw new Error("sn-links: lib/link-model.js must load before background.js");
}

const LM = globalThis.SnLinksLinkModel;

const INJECT_SCRIPT_ID = "sn-links-on-load";
const REFRESH_DEBOUNCE_MS = 100;

let linksCache = null;
/** @type {{ hostPattern: string | null, code: string }[]} */
let injectEntries = [];
let networkRulesState = defaultNetworkRulesState();
let extensionSettings = defaultExtensionSettings();
let networkHookVersion = "";
let networkLogToken = "";
let networkSharedState = {};
let networkTabState = {};
let injectRefreshTimer = null;
let networkRefreshTimer = null;
let networkNavigationHookRegistered = false;

async function getLinkSections() {
  if (!linksCache) {
    const response = await fetch(browser.runtime.getURL("data/links.json"));
    const bundled = await response.json();
    const overlay = await globalThis.SnLinksLinkCatalog.ensureLinksOverlayInStorage();
    linksCache = globalThis.SnLinksLinkCatalog.mergeLinksCatalog(bundled, overlay);
  }
  return linksCache;
}

function codesForUrl(url) {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return [];
  }

  return injectEntries
    .filter((entry) => LM.matchesHostPattern(url, entry.hostPattern))
    .map((entry) => entry.code);
}

async function loadExtensionSettings() {
  const stored = await browser.storage.local.get([
    NETWORK_HOOKS_ENABLED_KEY,
    INJECT_ON_LOAD_ENABLED_KEY,
    NETWORK_SHARED_STATE_KEY,
  ]);
  extensionSettings = {
    networkHooksEnabled: stored[NETWORK_HOOKS_ENABLED_KEY] !== false,
    injectOnLoadEnabled: stored[INJECT_ON_LOAD_ENABLED_KEY] !== false,
  };
  networkSharedState = stored[NETWORK_SHARED_STATE_KEY] || {};
  return extensionSettings;
}

async function loadNetworkTabState() {
  const stored = await browser.storage.session.get(NETWORK_TAB_STATE_KEY);
  networkTabState = stored[NETWORK_TAB_STATE_KEY] || {};
  return networkTabState;
}

function getSharedStateBundleForTab(tabId) {
  const tabKey = tabId == null ? "unknown" : String(tabId);
  return {
    persistent: { ...networkSharedState },
    tab: { ...(networkTabState[tabKey] || {}) },
  };
}

async function persistSharedState(persistent, tabStateFromPage, tabId) {
  if (persistent && typeof persistent === "object") {
    networkSharedState = { ...networkSharedState, ...persistent };
    await browser.storage.local.set({
      [NETWORK_SHARED_STATE_KEY]: networkSharedState,
    });
  }
  if (tabId == null) {
    return;
  }
  const tabKey = String(tabId);
  if (tabStateFromPage && typeof tabStateFromPage === "object") {
    networkTabState = {
      ...networkTabState,
      [tabKey]: { ...(networkTabState[tabKey] || {}), ...tabStateFromPage },
    };
    await browser.storage.session.set({
      [NETWORK_TAB_STATE_KEY]: networkTabState,
    });
  }
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
    LM.collectScriptlets(
      section.children || [],
      section.hostPattern ?? null,
      name,
      scriptlets
    );
  }

  injectEntries = [];
  for (const { linkKey, node } of scriptlets) {
    if (!injectOnLoad[linkKey]) continue;
    if (node.nav) continue;

    const parameterDefs = LM.getParameterDefs(node);
    const rawValues = paramValues[linkKey] || {};
    const values = LM.resolveParamValues(parameterDefs, rawValues);
    injectEntries.push({
      hostPattern: node.hostPattern ?? null,
      code: LM.applyParameters(node.code, values, { scriptlet: true }),
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
      matches: buildInjectContentScriptMatches(),
      runAt: "document_start",
      allFrames: true,
      js: [{ file: "inject/on-load.js" }],
    },
  ]);
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
      for (const code of codes) {
        await executeScriptletInTab(tab.id, code);
      }
    } catch {
      // restricted tab — skip
    }
  }
}

async function refreshInjectState() {
  await loadExtensionSettings();
  await rebuildInjectCache();
  await syncInjectRegistration();
  await reinjectOnLoadAllTabs();
}

async function loadNetworkRulesState() {
  const stored = await browser.storage.local.get(NETWORK_RULES_KEY);
  networkRulesState = stored[NETWORK_RULES_KEY] || defaultNetworkRulesState();
  if (!Array.isArray(networkRulesState.rules)) {
    networkRulesState.rules = [];
  }
  networkHookVersion = getNetworkHookVersion({
    enabled: networkRulesState.enabled,
    rules: rulesForPageHook(networkRulesState.rules),
    sharedState: networkSharedState,
  });
  return networkRulesState;
}

function pageHookRules() {
  if (!extensionSettings.networkHooksEnabled || !networkRulesState.enabled) {
    return [];
  }
  return rulesForPageHook(enabledNetworkRules());
}

function getHookVersionForTab(tabId) {
  const rules = pageHookRules();
  const tabKey = tabId == null ? "" : String(tabId);
  return getNetworkHookVersion({
    enabled: networkRulesState.enabled,
    rules,
    sharedState: networkSharedState,
    tabState: networkTabState[tabKey] || {},
  });
}

function enabledNetworkRules() {
  if (!networkRulesState.enabled) {
    return [];
  }
  return networkRulesState.rules.filter((rule) => rule.enabled);
}

async function installNetworkHookInTab(tabId, frameId) {
  const rules = pageHookRules();
  if (!rules.length) {
    return;
  }

  const target = { tabId };
  if (frameId != null) {
    target.frameIds = [frameId];
  }

  const sharedStateBundle = getSharedStateBundleForTab(tabId);
  const hookVersion = getHookVersionForTab(tabId);

  await browser.scripting.executeScript({
    target,
    world: "MAIN",
    injectImmediately: true,
    func: installNetworkHook,
    args: [rules, hookVersion, networkLogToken, sharedStateBundle],
  });
}

async function syncNetworkHookRegistration() {
  const scriptIds = [
    NETWORK_MAIN_HOOK_SCRIPT_ID,
    NETWORK_LOG_BRIDGE_SCRIPT_ID,
  ];

  for (const id of scriptIds) {
    try {
      await browser.scripting.unregisterContentScripts({ ids: [id] });
    } catch {
      // not registered yet
    }
  }

  const allRules = enabledNetworkRules();
  const rules = pageHookRules();

  if (
    !extensionSettings.networkHooksEnabled ||
    !networkRulesState.enabled ||
    !allRules.length ||
    !rules.length
  ) {
    return;
  }

  networkLogToken = crypto.randomUUID();
  const matches = buildNetworkHookMatches();

  await browser.scripting.registerContentScripts([
    {
      id: NETWORK_MAIN_HOOK_SCRIPT_ID,
      matches,
      runAt: "document_start",
      allFrames: true,
      js: [{ file: "inject/network-hook-bootstrap.js" }],
    },
    {
      id: NETWORK_LOG_BRIDGE_SCRIPT_ID,
      matches,
      runAt: "document_start",
      allFrames: true,
      js: [{ code: buildLogBridgeBootstrap(networkLogToken) }],
    },
  ]);
}

async function refreshNetworkRulesState() {
  await loadExtensionSettings();
  await loadNetworkTabState();
  await loadNetworkRulesState();
  syncNetworkWebRequest(
    networkRulesState,
    extensionSettings.networkHooksEnabled,
    networkSharedState
  );
  await syncNetworkHookRegistration();
}

async function setTabRuleBadge(tabId) {
  if (tabId == null || tabId < 0) {
    return;
  }
  try {
    await browser.action.setBadgeBackgroundColor({ color: "#81b5a1", tabId });
    await browser.action.setBadgeText({ text: "●", tabId });
  } catch {
    // badge unsupported or tab gone
  }
}

async function appendNetworkRuleLog(entry, tabId) {
  const sanitized = sanitizeLogEntry(entry);
  if (!sanitized) {
    return;
  }
  const stored = await browser.storage.session.get(NETWORK_RULES_LOG_KEY);
  const entries = trimLogEntries([...(stored[NETWORK_RULES_LOG_KEY] || []), sanitized]);
  await browser.storage.session.set({ [NETWORK_RULES_LOG_KEY]: entries });
  if (tabId != null && tabId >= 0) {
    await setTabRuleBadge(tabId);
  }
}

async function reinjectNetworkHookAllTabs() {
  const rules = pageHookRules();
  if (!rules.length) {
    return;
  }

  await loadNetworkTabState();
  networkLogToken = crypto.randomUUID();

  const tabs = await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
  for (const tab of tabs) {
    if (!tab.id) {
      continue;
    }
    try {
      await installNetworkHookInTab(tab.id);
    } catch {
      // restricted tab — skip
    }
  }
}

async function onNavigationCommitted(details) {
  if (details.tabId < 0) {
    return;
  }
  if (!/^https?:/i.test(details.url || "")) {
    return;
  }
  if (!pageHookRules().length) {
    return;
  }

  await loadNetworkTabState();
  try {
    await installNetworkHookInTab(details.tabId);
  } catch {
    // restricted tab — skip
  }
}

function initNetworkNavigationHook() {
  if (networkNavigationHookRegistered) {
    return;
  }
  browser.webNavigation.onCommitted.addListener((details) => {
    onNavigationCommitted(details).catch(() => {});
  });
  networkNavigationHookRegistered = true;
}

function runInjectedSource(source) {
  new Function(source)();
}

async function executeScriptletInTab(tabId, code, frameId) {
  const target = { tabId };
  if (frameId != null) {
    target.frameIds = [frameId];
  }
  await browser.scripting.executeScript({
    target,
    world: "MAIN",
    injectImmediately: true,
    func: runInjectedSource,
    args: [code],
  });
}

function scheduleRefreshInjectState() {
  clearTimeout(injectRefreshTimer);
  injectRefreshTimer = setTimeout(() => {
    refreshInjectState().catch(() => {});
  }, REFRESH_DEBOUNCE_MS);
}

function scheduleRefreshNetworkRulesState() {
  clearTimeout(networkRefreshTimer);
  networkRefreshTimer = setTimeout(() => {
    refreshNetworkRulesState()
      .then(() => reinjectNetworkHookAllTabs())
      .catch(() => {});
  }, REFRESH_DEBOUNCE_MS);
}

async function initExtension({ clearLinksCache = false } = {}) {
  if (clearLinksCache) {
    linksCache = null;
  }
  initCspDisable();
  initNetworkNavigationHook();
  await Promise.all([refreshInjectState(), refreshNetworkRulesState()]);
}

const messageHandlers = createBackgroundMessageHandlers({
  INJECT_ON_LOAD_KEY,
  PARAM_VALUES_KEY,
  CUSTOM_SCRIPTS_KEY,
  NETWORK_RULES_KEY,
  NETWORK_RULES_LOG_KEY,
  NETWORK_HOOKS_ENABLED_KEY,
  INJECT_ON_LOAD_ENABLED_KEY,
  extensionSettings: () => extensionSettings,
  codesForUrl,
  executeScriptletInTab,
  refreshInjectState,
  loadExtensionSettings,
  loadNetworkTabState,
  installNetworkHookInTab,
  refreshNetworkRulesState,
  reinjectNetworkHookAllTabs,
  loadNetworkRulesState,
  appendNetworkRuleLog,
  persistSharedState,
  pageHookRules,
  defaultNetworkRulesState,
  isCspDisabledForTab,
  setCspDisabledForTab,
});

browser.runtime.onMessage.addListener(createMessageRouter(messageHandlers));

browser.storage.onChanged.addListener((changes, area) => {
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
    if (
      changes[NETWORK_RULES_KEY] ||
      changes[NETWORK_HOOKS_ENABLED_KEY] ||
      changes[NETWORK_SHARED_STATE_KEY]
    ) {
      scheduleRefreshNetworkRulesState();
    }
    if (changes[NETWORK_HOOKS_ENABLED_KEY] || changes[INJECT_ON_LOAD_ENABLED_KEY]) {
      loadExtensionSettings();
    }
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  const tabKey = String(tabId);
  if (networkTabState[tabKey]) {
    delete networkTabState[tabKey];
    browser.storage.session.set({ [NETWORK_TAB_STATE_KEY]: networkTabState });
  }
  try {
    browser.action.setBadgeText({ text: "", tabId });
  } catch {
    // ignore
  }
});

browser.runtime.onInstalled.addListener(() => {
  initExtension({ clearLinksCache: true });
});

browser.runtime.onStartup.addListener(() => {
  initExtension();
});

initExtension();
