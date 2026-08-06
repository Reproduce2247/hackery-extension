import { isCspDisabledForTab, stripCspHeaders } from "../../lib/csp-disable.js";
import {
  applyModifyReplacementsToContext,
  appendNetworkLogQueue,
  compileRulesForMatching,
  getMatchingRules,
  getSortedEnabledRules,
  isTextLikeContentType,
  objectToWebRequestHeaders,
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
  if (!webRequestEnabled || details.tabId < 0) {
    return {};
  }
  if (shouldDeferToPageHook(details.type)) {
    return {};
  }

  const ctx = buildWebRequestContext(details, "request");
  const matching = getMatchingRules(webRequestRules, ctx).filter(
    (rule) =>
      rule.action === "modify" &&
      (rule.modify?.headerReplacements?.length ||
        rule.modify?.setHeaders?.length)
  );
  const headers = applyHeaderRules(matching, ctx, details.requestHeaders);
  return headers ? { requestHeaders: headers } : {};
}

function onHeadersReceived(details) {
  let responseHeaders = details.responseHeaders;

  if (isCspDisabledForTab(details.tabId)) {
    const stripped = stripCspHeaders(responseHeaders);
    if (stripped) {
      responseHeaders = stripped;
    }
  }

  if (!webRequestEnabled || details.tabId < 0) {
    return responseHeaders !== details.responseHeaders
      ? { responseHeaders }
      : {};
  }

  if (shouldDeferToPageHook(details.type)) {
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

  if (
    bodyRules.length &&
    (bodyRules.some((rule) => rule.action === "block") ||
      isTextLikeContentType(ctx.headers))
  ) {
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
          const result = applyResponseBodyRules(bodyRules, ctx, bodyText);
          if (result.blocked) {
            filter.write(encoder.encode(""));
          } else {
            filter.write(encoder.encode(result.body ?? bodyText));
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

  return responseHeaders !== details.responseHeaders
    ? { responseHeaders }
    : {};
}

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
  registerWebRequestListeners();
}
