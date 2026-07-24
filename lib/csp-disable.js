const CSP_HEADER_NAMES = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-content-security-policy",
  "x-webkit-csp",
]);

const cspDisabledTabs = new Set();
let cspTabCleanupRegistered = false;

function isCspDisabledForTab(tabId) {
  return tabId >= 0 && cspDisabledTabs.has(tabId);
}

function setCspDisabledForTab(tabId, disabled) {
  if (tabId == null || tabId < 0) {
    return;
  }
  if (disabled) {
    cspDisabledTabs.add(tabId);
  } else {
    cspDisabledTabs.delete(tabId);
  }
}

function stripCspHeaders(responseHeaders) {
  if (!responseHeaders?.length) {
    return null;
  }
  const filtered = responseHeaders.filter(
    (header) => !CSP_HEADER_NAMES.has(String(header.name || "").toLowerCase())
  );
  return filtered.length === responseHeaders.length ? null : filtered;
}

function initCspDisable() {
  if (cspTabCleanupRegistered) {
    return;
  }
  browser.tabs.onRemoved.addListener((tabId) => {
    cspDisabledTabs.delete(tabId);
  });
  cspTabCleanupRegistered = true;
}
