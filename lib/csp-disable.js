const CSP_HEADER_NAMES = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-content-security-policy",
  "x-webkit-csp",
]);

const cspDisabledTabs = new Set();
let cspTabCleanupRegistered = false;

export function isCspDisabledForTab(tabId) {
  return tabId >= 0 && cspDisabledTabs.has(tabId);
}

export function setCspDisabledForTab(tabId, disabled) {
  if (tabId == null || tabId < 0) {
    return;
  }
  if (disabled) {
    cspDisabledTabs.add(tabId);
  } else {
    cspDisabledTabs.delete(tabId);
  }
}

export function stripCspHeaders(responseHeaders) {
  if (!responseHeaders?.length) {
    return null;
  }
  const filtered = responseHeaders.filter(
    (header) => !CSP_HEADER_NAMES.has(String(header.name || "").toLowerCase())
  );
  return filtered.length === responseHeaders.length ? null : filtered;
}

export function initCspDisable() {
  if (cspTabCleanupRegistered) {
    return;
  }
  browser.tabs.onRemoved.addListener((tabId) => {
    cspDisabledTabs.delete(tabId);
  });
  cspTabCleanupRegistered = true;
}
