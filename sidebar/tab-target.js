/** Thin ES-module facade over lib/tab-target.js (loaded via script tag). */
const T = () => globalThis.SnLinksTabTarget;

export async function getActiveTab() {
  return T().getActiveTab();
}

export async function rememberOrigin(hostPattern, origin) {
  return T().rememberOrigin(hostPattern, origin);
}

export async function getRememberedOrigin(hostPattern) {
  return T().getRememberedOrigin(hostPattern);
}

export async function findMatchingTab(hostPattern, preferredOrigin, activeTab) {
  return T().findMatchingTab(hostPattern, preferredOrigin, activeTab);
}

export async function ensureMatchingTab(hostPattern, origin, activeTab) {
  return T().ensureMatchingTab(hostPattern, origin, activeTab);
}

export async function waitForTabLoad(tabId) {
  return T().waitForTabLoad(tabId);
}

export async function getActiveTargetTab() {
  return T().getActiveTargetTab();
}

export async function getTargetTab(hostPattern) {
  return T().getTargetTab(hostPattern);
}
