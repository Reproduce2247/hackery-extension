/**
 * Tab targeting and origin memory (shared by sidebar UI and background activation).
 */
import { matchesHostPattern } from "./link-model.js";
import { StorageKeys } from "./storage-keys.js";
import { originsEqual } from "./url-normalize.js";

const { LAST_ORIGINS_KEY } = StorageKeys;
const TAB_LOAD_TIMEOUT_MS = 30000;

export async function getActiveTab() {
  let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    return tab;
  }
  [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

export async function rememberOrigin(hostPattern, origin) {
  const stored = await browser.storage.local.get(LAST_ORIGINS_KEY);
  const lastOrigins = stored[LAST_ORIGINS_KEY] || {};
  lastOrigins[hostPattern] = origin;
  await browser.storage.local.set({ [LAST_ORIGINS_KEY]: lastOrigins });
}

export async function getRememberedOrigin(hostPattern) {
  const stored = await browser.storage.local.get(LAST_ORIGINS_KEY);
  return (stored[LAST_ORIGINS_KEY] || {})[hostPattern] || null;
}

function tabOrigin(tab) {
  try {
    return tab?.url ? new URL(tab.url).origin : null;
  } catch {
    return null;
  }
}

export async function findMatchingTab(hostPattern, preferredOrigin, activeTab) {
  const tabs = await browser.tabs.query({ currentWindow: true });
  const active = activeTab ?? (await getActiveTab());
  const activeIndex = active?.index ?? 0;

  const matchingTabs = tabs.filter(
    (tab) => tab.url && matchesHostPattern(tab.url, hostPattern)
  );

  if (matchingTabs.length === 0) {
    return null;
  }

  function distanceFromActive(tab) {
    return Math.abs(tab.index - activeIndex);
  }

  function nearestTab(candidates) {
    return [...candidates].sort((a, b) => {
      const loadRank =
        (a.status === "complete" ? 0 : 1) - (b.status === "complete" ? 0 : 1);
      if (loadRank !== 0) {
        return loadRank;
      }
      const dist = distanceFromActive(a) - distanceFromActive(b);
      if (dist !== 0) {
        return dist;
      }
      return a.index - b.index;
    })[0];
  }

  if (preferredOrigin) {
    const originMatches = matchingTabs.filter((tab) => {
      const origin = tabOrigin(tab);
      return originsEqual(origin, preferredOrigin);
    });
    if (originMatches.length > 0) {
      return nearestTab(originMatches);
    }
  }

  return nearestTab(matchingTabs);
}

export async function ensureMatchingTab(hostPattern, origin, activeTab) {
  const existing = await findMatchingTab(hostPattern, origin, activeTab);
  if (existing) {
    return existing;
  }

  if (!origin) {
    throw new Error(
      `Open a tab matching /${hostPattern}/ first, or visit one so the extension can remember it.`
    );
  }

  return browser.tabs.create({ url: `${origin}/`, active: false });
}

export async function waitForTabLoad(tabId) {
  const tab = await browser.tabs.get(tabId);
  if (tab.status === "complete") {
    return tab;
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      reject(new Error("Tab load timed out."));
    }, TAB_LOAD_TIMEOUT_MS);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeoutId);
        browser.tabs.onUpdated.removeListener(listener);
        browser.tabs.get(tabId).then(resolve).catch(reject);
      }
    };
    browser.tabs.onUpdated.addListener(listener);
  });
}

export async function getActiveTargetTab() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    throw new Error("No active tab.");
  }
  const origin = tabOrigin(tab);
  return { tab, origin };
}

export async function getTargetTab(hostPattern) {
  if (!hostPattern) {
    return getActiveTargetTab();
  }

  const activeTab = await getActiveTab();
  let preferredOrigin = null;
  if (activeTab?.url && matchesHostPattern(activeTab.url, hostPattern)) {
    preferredOrigin = tabOrigin(activeTab);
  }

  const rememberedOrigin =
    preferredOrigin ?? (await getRememberedOrigin(hostPattern));
  const tab = await ensureMatchingTab(
    hostPattern,
    rememberedOrigin,
    activeTab
  );
  const loadedTab =
    tab.status === "complete" ? tab : await waitForTabLoad(tab.id);
  const origin = tabOrigin(loadedTab);
  await rememberOrigin(hostPattern, origin);
  return { tab: loadedTab, origin };
}
