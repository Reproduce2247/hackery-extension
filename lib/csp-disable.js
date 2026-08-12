/**
 * Per-tab "Disable CSP" toggle.
 *
 * Two mechanisms, deliberately:
 * - DNR session rules strip the response headers. Those rules live in the
 *   browser, not the extension, so they keep applying while the background
 *   event page is suspended and need no listener of ours to stay alive.
 * - A webRequest body filter removes meta-tag CSP, which DNR cannot reach.
 *   That path needs a synchronous answer, hence the storage.session mirror.
 *
 * The webRequest path also strips headers. That is not redundant: it runs on
 * whatever header array the network rules hand back, so stripping there stops a
 * header rule from reintroducing a policy the DNR rule already removed.
 */

const CSP_HEADER_NAMES = [
  "content-security-policy",
  "content-security-policy-report-only",
  "x-content-security-policy",
  "x-content-security-policy-report-only",
  "x-webkit-csp",
];

/**
 * Not CSP, and irrelevant to running eval in the page. Stripped by the same
 * toggle so an inspected page also drops its cross-origin isolation
 * restrictions, which otherwise block reading subresources while poking at it.
 */
const ISOLATION_HEADER_NAMES = [
  "cross-origin-resource-policy",
  "cross-origin-embedder-policy",
  "cross-origin-opener-policy",
];

const REMOVED_HEADER_NAMES = [...CSP_HEADER_NAMES, ...ISOLATION_HEADER_NAMES];
const REMOVED_HEADER_LOOKUP = new Set(REMOVED_HEADER_NAMES);

/**
 * Only content-security-policy(-report-only) are honored in meta form; the
 * x-* spellings and the isolation headers are header-only, so they are absent.
 */
const META_CSP_PATTERN =
  /<meta\b[^>]*?http-equiv\s*=\s*["']?content-security-policy(?:-report-only)?["']?[^>]*>/gi;

/**
 * storage.session, not local: tab ids are only meaningful for the lifetime of
 * the browser session, which is also the lifetime of a DNR session rule.
 */
const CSP_DISABLED_TABS_KEY = "cspDisabledTabs";

/** Offset so these ids cannot collide with session rules added elsewhere. */
const CSP_RULE_ID_BASE = 1000000;

/**
 * DNR matches every resource type except main_frame when the condition omits
 * resourceTypes, so documents have to be listed explicitly. The subresource
 * types are here for the isolation headers, which are enforced on subresources.
 * Every value is supported in Firefox 113+, well under the manifest floor —
 * one unsupported value would reject the whole updateSessionRules call.
 */
const CSP_RULE_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "script",
  "stylesheet",
  "xmlhttprequest",
  "image",
  "imageset",
  "font",
  "media",
  "object",
  "object_subrequest",
  "websocket",
  "web_manifest",
  "ping",
  "beacon",
  "csp_report",
  "other",
];

const CSP_ALARM_PREFIX = "csp-disable-expire:";

/** Auto-expiry so a tab is not left without CSP for the rest of the session. */
export const CSP_DISABLE_MINUTES = 10;

/** @type {Set<number>} */
const cspDisabledTabs = new Set();
/** @type {Promise<void> | null} */
let cspStateHydration = null;
let cspStateHydrated = false;
let cspTabCleanupRegistered = false;

function cspRuleIdForTab(tabId) {
  return CSP_RULE_ID_BASE + tabId;
}

function cspRuleForTab(tabId) {
  return {
    id: cspRuleIdForTab(tabId),
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: REMOVED_HEADER_NAMES.map((header) => ({
        header,
        operation: "remove",
      })),
    },
    condition: {
      tabIds: [tabId],
      resourceTypes: CSP_RULE_RESOURCE_TYPES,
    },
  };
}

/**
 * Add or drop the header-stripping rule for one tab.
 * @param {number} tabId
 * @param {boolean} disabled
 */
async function syncCspRuleForTab(tabId, disabled) {
  try {
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [cspRuleIdForTab(tabId)],
      addRules: disabled ? [cspRuleForTab(tabId)] : [],
    });
    console.log(
      `CSP headers ${disabled ? "stripped" : "restored"} for tab ${tabId}`,
      disabled ? REMOVED_HEADER_NAMES : ""
    );
  } catch (error) {
    console.error("CSP session rule update failed:", error);
  }
}

function persistCspDisabledTabs() {
  browser.storage.session
    .set({ [CSP_DISABLED_TABS_KEY]: [...cspDisabledTabs] })
    .catch(() => {});
}

/**
 * Blocking webRequest listeners must answer synchronously, but the disabled-tab
 * set has to be reloaded from storage.session after every event-page wake-up.
 * Callers check this once and await it before trusting isCspDisabledForTab.
 * @returns {Promise<void> | null} null once the set is in memory.
 */
export function whenCspStateReady() {
  if (cspStateHydrated) {
    return null;
  }
  if (!cspStateHydration) {
    cspStateHydration = browser.storage.session
      .get(CSP_DISABLED_TABS_KEY)
      .then((stored) => {
        for (const tabId of stored[CSP_DISABLED_TABS_KEY] || []) {
          const id = Number(tabId);
          if (Number.isInteger(id) && id >= 0) {
            cspDisabledTabs.add(id);
          }
        }
      })
      .catch(() => {})
      .then(() => {
        cspStateHydrated = true;
      });
  }
  return cspStateHydration;
}

export function isCspDisabledForTab(tabId) {
  return tabId >= 0 && cspDisabledTabs.has(tabId);
}

/**
 * @param {number} tabId
 * @param {boolean} disabled
 * @returns {Promise<void>}
 */
export async function setCspDisabledForTab(tabId, disabled) {
  if (tabId == null || tabId < 0) {
    return;
  }
  if (disabled) {
    cspDisabledTabs.add(tabId);
  } else {
    cspDisabledTabs.delete(tabId);
  }
  persistCspDisabledTabs();

  // alarms, not setTimeout: a timer would die with the event page.
  const alarmName = `${CSP_ALARM_PREFIX}${tabId}`;
  if (disabled) {
    browser.alarms.create(alarmName, { delayInMinutes: CSP_DISABLE_MINUTES });
  } else {
    browser.alarms.clear(alarmName).catch(() => {});
  }

  await syncCspRuleForTab(tabId, disabled);
}

export function stripCspHeaders(responseHeaders) {
  if (!responseHeaders?.length) {
    return null;
  }
  const filtered = responseHeaders.filter(
    (header) => !REMOVED_HEADER_LOOKUP.has(String(header.name || "").toLowerCase())
  );
  if (filtered.length === responseHeaders.length) {
    return null;
  }
  const removed = responseHeaders
    .filter((header) =>
      REMOVED_HEADER_LOOKUP.has(String(header.name || "").toLowerCase())
    )
    .map((header) => header.name);
  console.log("CSP headers removed by webRequest:", removed.join(", "));
  return filtered;
}

/**
 * Remove meta-tag CSP from an HTML document. Header stripping cannot reach
 * these: the parser applies a meta policy as soon as it reads the tag, and it
 * cannot be lifted afterwards, so the tag has to be gone before parsing.
 *
 * Regex rather than DOMParser on purpose. Reserializing a parsed document
 * through outerHTML drops the doctype and rewrites the whole page, which can
 * flip it into quirks mode; this only cuts out the tags themselves.
 * @param {string} html
 * @param {string} [url] For the log line only.
 * @returns {string | null} null when the document carries no meta CSP.
 */
export function stripMetaCspTags(html, url = "") {
  if (!html || !/content-security-policy/i.test(html)) {
    return null;
  }
  const removed = html.match(META_CSP_PATTERN);
  if (!removed) {
    return null;
  }
  console.log(`Removed ${removed.length} meta CSP tag(s) from ${url}`, removed);
  return html.replace(META_CSP_PATTERN, "");
}

/**
 * Re-add session rules for tabs recorded before the last background restart.
 * Normally a no-op, since DNR session rules and storage.session share a
 * lifetime; this only self-heals if one of the two was cleared on its own.
 */
async function reconcileCspRules() {
  await whenCspStateReady();
  if (!cspDisabledTabs.size) {
    return;
  }
  const tabIds = [...cspDisabledTabs];
  try {
    await browser.declarativeNetRequest.updateSessionRules({
      removeRuleIds: tabIds.map(cspRuleIdForTab),
      addRules: tabIds.map(cspRuleForTab),
    });
  } catch (error) {
    console.error("CSP session rule reconcile failed:", error);
  }
}

export function initCspDisable() {
  if (cspTabCleanupRegistered) {
    return;
  }

  browser.tabs.onRemoved.addListener((tabId) => {
    // Hydrate first, or a closed tab recorded before the last suspension would
    // stay in storage.session and leak onto whichever tab reuses its id.
    void Promise.resolve(whenCspStateReady()).then(() => {
      if (cspDisabledTabs.has(tabId)) {
        void setCspDisabledForTab(tabId, false);
      }
    });
  });

  browser.alarms.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith(CSP_ALARM_PREFIX)) {
      return;
    }
    const tabId = Number(alarm.name.slice(CSP_ALARM_PREFIX.length));
    if (!Number.isInteger(tabId)) {
      return;
    }
    void Promise.resolve(whenCspStateReady()).then(() => {
      console.log(`CSP re-enabled for tab ${tabId} after ${CSP_DISABLE_MINUTES}m`);
      return setCspDisabledForTab(tabId, false);
    });
  });

  cspTabCleanupRegistered = true;
  void reconcileCspRules();
}
