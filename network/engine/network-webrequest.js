import {
  isCspDisabledForTab,
  stripCspHeaders,
  stripMetaCspTags,
  whenCspStateReady,
} from "../../lib/csp-disable.js";
import {
  applyModifyReplacementsToContext,
  appendNetworkLogQueue,
  compileRulesForMatching,
  getMatchingRules,
  getSortedEnabledRules,
  isTextLikeContentType,
  objectToWebRequestHeaders,
  rewritePrivilegedRequestHeaders,
  rulesForPageHook,
  sanitizeLogEntry,
  webRequestHeadersToObject,
} from "./network-rules-shared.js";
import { NETWORK_RULES_LOG_KEY, NETWORK_SHARED_STATE_KEY } from "../storage-keys.js";

let webRequestRules = [];
let webRequestEnabled = false;
let webRequestListenersRegistered = false;
let webRequestPageHookActive = false;
let webRequestSharedState = {};
/** @type {Map<number, string>} */
const networkTabUrls = new Map();

/** @type {((entry: object, tabId?: number) => Promise<void>) | null} */
let appendNetworkRuleLogFn = null;

/**
 * Wire in the shared append-log function owned by network/background.js so
 * webRequest-originated matches land in the same log queue as page-hook matches.
 * @param {{ appendNetworkRuleLog: (entry: object, tabId?: number) => Promise<void> }} deps
 */
export function configureNetworkWebRequest({ appendNetworkRuleLog }) {
  appendNetworkRuleLogFn = appendNetworkRuleLog || null;
}

/**
 * Cache the top-level tab URL for PAGE URL matching in blocking webRequest.
 * @param {number} tabId
 * @param {string} url
 */
export function rememberNetworkTabUrl(tabId, url) {
  if (tabId == null || tabId < 0) {
    return;
  }
  if (!url || !/^https?:/i.test(url)) {
    networkTabUrls.delete(tabId);
    return;
  }
  networkTabUrls.set(tabId, url);
}

/**
 * Drop a cached tab URL when the tab closes.
 * @param {number} tabId
 */
export function forgetNetworkTabUrl(tabId) {
  networkTabUrls.delete(tabId);
}

function persistWebRequestSharedState() {
  if (!Object.keys(webRequestSharedState).length) {
    return;
  }
  browser.storage.local
    .set({ [NETWORK_SHARED_STATE_KEY]: webRequestSharedState })
    .catch(() => {});
}

async function logWebRequestRule(entry, tabId) {
  if (typeof appendNetworkRuleLogFn === "function") {
    await appendNetworkRuleLogFn({ ...entry, via: "webRequest" }, tabId);
    return;
  }
  const sanitized = sanitizeLogEntry({ ...entry, via: "webRequest" });
  if (!sanitized) {
    return;
  }
  const stored = await browser.storage.session.get(NETWORK_RULES_LOG_KEY);
  const entries = appendNetworkLogQueue(stored[NETWORK_RULES_LOG_KEY] || [], sanitized);
  await browser.storage.session.set({ [NETWORK_RULES_LOG_KEY]: entries });
}

function buildWebRequestContext(details, phase) {
  const tabUrl =
    details.tabId >= 0 ? networkTabUrls.get(details.tabId) || "" : "";
  return {
    phase,
    method: details.method || "GET",
    url: details.url,
    // Prefer top-level tab URL for PAGE URL filters.
    pageUrl: tabUrl || details.documentUrl || details.originUrl || "",
    resourceType: details.type || "",
    tabId: details.tabId,
    headers: webRequestHeadersToObject(
      phase === "request" ? details.requestHeaders : details.responseHeaders
    ),
    status: details.statusCode,
  };
}

function isPageHookResourceType(resourceType) {
  return resourceType === "xmlhttprequest";
}

function shouldDeferToPageHook(resourceType) {
  return webRequestPageHookActive && isPageHookResourceType(resourceType);
}

function responseNeedsBodyFilter(rule, resourceType) {
  if (resourceType === "xmlhttprequest") {
    return false;
  }
  const phases = rule.phases?.length ? rule.phases : ["request", "response"];
  if (!phases.includes("response")) {
    return false;
  }
  if (rule.action === "block") {
    return true;
  }
  const mod = rule.modify || {};
  // Scripts are page-hook only today; keep body replacements declarative here.
  return Boolean(mod.bodyReplacements?.length);
}

function processRequestControlRules(rules, ctx) {
  let nextUrl = ctx.url;

  for (const rule of rules) {
    if (rule.action === "block") {
      logWebRequestRule({
        ruleId: rule.id,
        ruleName: rule.name,
        phase: "request",
        method: ctx.method,
        url: ctx.url,
        pageUrl: ctx.pageUrl,
        resourceType: ctx.resourceType,
        outcome: "blocked",
        action: "block",
      }, ctx.tabId);
      return { cancel: true };
    }

    if (rule.action === "redirect" && rule.redirectUrl) {
      nextUrl = rule.redirectUrl;
      logWebRequestRule({
        ruleId: rule.id,
        ruleName: rule.name,
        phase: "request",
        method: ctx.method,
        url: nextUrl,
        pageUrl: ctx.pageUrl,
        resourceType: ctx.resourceType,
        outcome: "redirect",
        action: "redirect",
      }, ctx.tabId);
      continue;
    }

    if (rule.action === "modify" && rule.modify?.urlReplacements?.length) {
      const modified = applyModifyReplacementsToContext(
        { ...ctx, url: nextUrl },
        rule
      );
      if (modified.url && modified.url !== nextUrl) {
        nextUrl = modified.url;
        logWebRequestRule({
          ruleId: rule.id,
          ruleName: rule.name,
          phase: "request",
          method: ctx.method,
          url: nextUrl,
          pageUrl: ctx.pageUrl,
          resourceType: ctx.resourceType,
          outcome: "redirect",
          action: "modify",
        }, ctx.tabId);
      }
    }
  }

  if (nextUrl !== ctx.url) {
    return { redirectUrl: nextUrl };
  }
  return null;
}

function applyHeaderRules(rules, ctx, headerList) {
  let headers = webRequestHeadersToObject(headerList);
  let changed = false;

  for (const rule of rules) {
    if (rule.action !== "modify") {
      continue;
    }
    const mod = rule.modify || {};
    if (mod.headerReplacements?.length || mod.setHeaders?.length) {
      const before = JSON.stringify(headers);
      headers = applyModifyReplacementsToContext(
        { ...ctx, headers: { ...headers } },
        rule
      ).headers;
      // Future (CSP-safe interpreter): apply requestScript via webRequest here.
      if (JSON.stringify(headers) !== before) {
        changed = true;
        logWebRequestRule({
          ruleId: rule.id,
          ruleName: rule.name,
          phase: ctx.phase,
          method: ctx.method,
          url: ctx.url,
          pageUrl: ctx.pageUrl,
          resourceType: ctx.resourceType,
          outcome: "modified",
          action: "modify",
        }, ctx.tabId);
      }
    }
  }

  persistWebRequestSharedState();
  return changed ? objectToWebRequestHeaders(headers) : null;
}

function applyResponseBodyRules(rules, ctx, bodyText) {
  let body = bodyText;
  let status = ctx.status;

  for (const rule of rules) {
    if (rule.action === "block") {
      logWebRequestRule({
        ruleId: rule.id,
        ruleName: rule.name,
        phase: "response",
        method: ctx.method,
        url: ctx.url,
        pageUrl: ctx.pageUrl,
        resourceType: ctx.resourceType,
        outcome: "blocked",
        action: "block",
      }, ctx.tabId);
      return { blocked: true, body: "" };
    }

    if (rule.action !== "modify") {
      continue;
    }

    const before = { body, status };
    const nextCtx = applyModifyReplacementsToContext(
      { ...ctx, body, status },
      rule
    );
    // Future (CSP-safe interpreter): apply responseScript via webRequest here.

    body = nextCtx.body ?? body;
    status = nextCtx.status ?? status;
    if (body !== before.body || status !== before.status) {
      logWebRequestRule({
        ruleId: rule.id,
        ruleName: rule.name,
        phase: "response",
        method: ctx.method,
        url: ctx.url,
        pageUrl: ctx.pageUrl,
        resourceType: ctx.resourceType,
        outcome: "modified",
        action: "modify",
      }, ctx.tabId);
    }
  }

  persistWebRequestSharedState();

  return { blocked: false, body, status };
}

function onBeforeRequest(details) {
  if (!webRequestEnabled || details.tabId < 0) {
    return {};
  }
  if (shouldDeferToPageHook(details.type)) {
    return {};
  }

  const ctx = buildWebRequestContext(details, "request");
  const matching = getMatchingRules(webRequestRules, ctx).filter(
    (rule) =>
      rule.action === "block" ||
      rule.action === "redirect" ||
      (rule.action === "modify" && rule.modify?.urlReplacements?.length)
  );

  const result = processRequestControlRules(matching, ctx);
  return result || {};
}

function onBeforeSendHeaders(details) {
  // Always rewrite page-hook dummy headers, even when rule matching defers to
  // the page hook for fetch/XHR — otherwise Cookie/Origin/Referer never land.
  const rewritten = rewritePrivilegedRequestHeaders(details.requestHeaders);
  let headers = rewritten.headers;
  let changed = rewritten.changed;

  if (!webRequestEnabled || details.tabId < 0) {
    return changed ? { requestHeaders: headers } : {};
  }
  if (shouldDeferToPageHook(details.type)) {
    return changed ? { requestHeaders: headers } : {};
  }

  const ctx = buildWebRequestContext(
    { ...details, requestHeaders: headers },
    "request"
  );
  const matching = getMatchingRules(webRequestRules, ctx).filter(
    (rule) =>
      rule.action === "modify" &&
      (rule.modify?.headerReplacements?.length ||
        rule.modify?.setHeaders?.length)
  );
  const applied = applyHeaderRules(matching, ctx, headers);
  if (applied) {
    return { requestHeaders: applied };
  }
  return changed ? { requestHeaders: headers } : {};
}

/**
 * Whether a response is an HTML document safe to rewrite for meta-CSP stripping.
 * Missing Content-Type counts as HTML: Firefox sniffs those for documents.
 * A declared non-UTF-8 charset disqualifies it — the filter decodes and
 * re-encodes as UTF-8, which would corrupt anything else.
 * @param {object} details webRequest details for the response.
 * @param {Record<string, string>} headers Response headers, original casing.
 */
function isHtmlDocumentResponse(details, headers) {
  if (details.type !== "main_frame" && details.type !== "sub_frame") {
    return false;
  }
  const contentType = String(
    headers?.["Content-Type"] || headers?.["content-type"] || ""
  ).toLowerCase();
  if (contentType && !contentType.includes("html")) {
    return false;
  }
  const charset = /charset\s*=\s*"?([^";]+)/.exec(contentType)?.[1]?.trim();
  return !charset || charset === "utf-8" || charset === "us-ascii";
}

/**
 * Buffer the whole response so text rules and meta-CSP stripping can rewrite it.
 * Note this delays first paint until the response completes, and leaves any
 * Content-Length header stale — acceptable for opt-in rules and the CSP toggle.
 * @param {object} details webRequest details for the response.
 * @param {object[]} bodyRules Rules needing body access (may be empty).
 * @param {object} ctx Rule-matching context for this response.
 * @param {boolean} stripMetaCsp Remove meta CSP tags before rules run.
 */
function filterResponseBody(details, bodyRules, ctx, stripMetaCsp) {
  try {
    const filter = browser.webRequest.filterResponseData(details.requestId);
    const decoder = new TextDecoder("utf-8");
    const encoder = new TextEncoder();
    const chunks = [];

    filter.ondata = (event) => {
      chunks.push(event.data);
    };

    filter.onstop = () => {
      try {
        const totalLength = chunks.reduce(
          (sum, chunk) => sum + chunk.byteLength,
          0
        );
        const merged = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(new Uint8Array(chunk), offset);
          offset += chunk.byteLength;
        }

        let bodyText = decoder.decode(merged);
        if (stripMetaCsp) {
          bodyText = stripMetaCspTags(bodyText, details.url) ?? bodyText;
        }
        if (!bodyRules.length) {
          filter.write(encoder.encode(bodyText));
        } else {
          const result = applyResponseBodyRules(bodyRules, ctx, bodyText);
          filter.write(encoder.encode(result.blocked ? "" : result.body ?? bodyText));
        }
      } catch {
        for (const chunk of chunks) {
          filter.write(chunk);
        }
      }
      filter.close();
    };

    filter.onerror = () => {
      filter.disconnect();
    };
  } catch {
    // filterResponseData unavailable for this request
  }
}

function applyHeadersReceived(details) {
  let responseHeaders = details.responseHeaders;
  const cspDisabled = isCspDisabledForTab(details.tabId);
  const headerObject = webRequestHeadersToObject(responseHeaders);
  const stripMetaCsp =
    cspDisabled && isHtmlDocumentResponse(details, headerObject);

  if (cspDisabled) {
    const stripped = stripCspHeaders(responseHeaders);
    if (stripped) {
      responseHeaders = stripped;
    }
  }

  const rulesApply =
    webRequestEnabled &&
    details.tabId >= 0 &&
    !shouldDeferToPageHook(details.type);

  if (!rulesApply) {
    if (stripMetaCsp) {
      filterResponseBody(details, [], null, true);
    }
    return responseHeaders !== details.responseHeaders
      ? { responseHeaders }
      : {};
  }

  const ctx = buildWebRequestContext(
    { ...details, responseHeaders },
    "response"
  );
  const matching = getMatchingRules(webRequestRules, ctx);
  const headerRules = matching.filter(
    (rule) =>
      rule.action === "modify" &&
      (rule.modify?.headerReplacements?.length || rule.modify?.setHeaders?.length)
  );
  const networkHeaderChange = applyHeaderRules(
    headerRules,
    ctx,
    responseHeaders
  );
  if (networkHeaderChange) {
    responseHeaders = networkHeaderChange;
  }

  const bodyRules = matching.filter((rule) =>
    responseNeedsBodyFilter(rule, ctx.resourceType)
  );
  const bodyRulesNeedFilter =
    bodyRules.length > 0 &&
    (bodyRules.some((rule) => rule.action === "block") ||
      isTextLikeContentType(ctx.headers));

  // One filterResponseData per request, so both concerns share a single filter.
  if (bodyRulesNeedFilter || stripMetaCsp) {
    filterResponseBody(
      details,
      bodyRulesNeedFilter ? bodyRules : [],
      ctx,
      stripMetaCsp
    );
  }

  return responseHeaders !== details.responseHeaders
    ? { responseHeaders }
    : {};
}

function onHeadersReceived(details) {
  // This listener is registered at load so Firefox can wake the event page for
  // it, which means the first responses after a wake-up arrive before the
  // disabled-tab set has been read back. Firefox lets a blocking listener
  // return a promise, so stall those rather than let CSP through unstripped.
  const pending = whenCspStateReady();
  if (pending) {
    return pending.then(() => applyHeadersReceived(details));
  }
  return applyHeadersReceived(details);
}

/**
 * Firefox only wakes an event page for listeners added synchronously during the
 * background script's first run, so this runs at module load rather than from
 * syncNetworkWebRequest. Registering late meant CSP stripping and rule matching
 * silently stopped once the background suspended. The handlers read the
 * webRequest* module state, which stays empty until the first sync — safe,
 * because empty state simply means no rules match.
 */
function registerWebRequestListeners() {
  if (webRequestListenersRegistered) {
    return;
  }

  const urls = ["<all_urls>"];
  browser.webRequest.onBeforeRequest.addListener(onBeforeRequest, { urls }, [
    "blocking",
  ]);
  browser.webRequest.onBeforeSendHeaders.addListener(
    onBeforeSendHeaders,
    { urls },
    ["blocking", "requestHeaders"]
  );
  browser.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls },
    ["blocking", "responseHeaders"]
  );
  webRequestListenersRegistered = true;
}

export function syncNetworkWebRequest(state, hooksEnabled = true, sharedState = {}) {
  webRequestSharedState =
    sharedState && typeof sharedState === "object" ? sharedState : {};
  webRequestEnabled = Boolean(hooksEnabled && state?.enabled);
  webRequestRules = compileRulesForMatching(getSortedEnabledRules(state?.rules || []));
  webRequestPageHookActive =
    webRequestEnabled && rulesForPageHook(state?.rules || []).length > 0;
  if (!hooksEnabled) {
    webRequestEnabled = false;
    webRequestPageHookActive = false;
  }
}

registerWebRequestListeners();
