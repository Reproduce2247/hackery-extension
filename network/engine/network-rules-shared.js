import {
  attachCompiledNetworkRules,
  compileNetworkRulesCache,
  createNetworkRuleEngine,
} from "./network-rule-engine-core.js";

export const NETWORK_MAIN_HOOK_SCRIPT_ID = "complex-linker-network-hook-main";
export const NETWORK_LOG_BRIDGE_SCRIPT_ID = "complex-linker-network-log-bridge";
const NETWORK_LOG_LIMIT = 100;

export const NETWORK_ACTIONS = ["block", "redirect", "modify", "mock"];
export const NETWORK_PHASES = ["request", "response"];
export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

export const WEBREQUEST_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "other",
];

const sharedRuleEngine = createNetworkRuleEngine();

export function defaultNetworkRulesState() {
  return { enabled: true, rules: [] };
}

export function createEmptyRule() {
  return {
    id: crypto.randomUUID(),
    name: "New rule",
    enabled: true,
    priority: 100,
    hostPattern: "",
    pageHostPattern: "",
    pageUrlPattern: "",
    requestUrlPattern: "",
    requestContentTypePattern: "",
    requestBodyPattern: "",
    methods: [],
    resourceTypes: [],
    phases: ["request"],
    responseStatusMin: null,
    responseStatusMax: null,
    action: "modify",
    redirectUrl: "",
    matchHookOriginated: false,
    modify: {
      urlReplacements: [],
      bodyReplacements: [],
      headerReplacements: [],
      setHeaders: [],
      requestScript: "",
      responseScript: "",
      serveWithoutRequest: false,
      mockStatus: 200,
      mockStatusText: "OK",
      mockBody: "",
    },
  };
}

export function ruleMatchesContext(rule, ctx) {
  return sharedRuleEngine.ruleMatches(rule, ctx);
}

export function applyStringReplacements(value, replacements) {
  return sharedRuleEngine.applyStringReplacements(value, replacements);
}

export function getSortedEnabledRules(rules) {
  return sharedRuleEngine.getSortedEnabledRules(rules);
}

export function getMatchingRules(rules, ctx) {
  return getSortedEnabledRules(rules).filter((rule) => ruleMatchesContext(rule, ctx));
}

export function compileRulesForMatching(rules) {
  const compiledById = compileNetworkRulesCache(rules);
  return attachCompiledNetworkRules(rules, compiledById);
}

export function applyModifyReplacementsToContext(ctx, rule) {
  return sharedRuleEngine.applyModifyReplacements(ctx, rule);
}

export function createSharedStateView(persistentState, tabState) {
  return {
    persistent: persistentState || {},
    tab: tabState || {},
    get shared() {
      return { ...this.persistent, ...this.tab };
    },
  };
}

export function attachSharedStateToContext(ctx, stateView) {
  return sharedRuleEngine.attachSharedState(ctx, stateView);
}

export function runNetworkRuleScript(ctx, script, rule, onError, stateView) {
  const engine = onError
    ? createNetworkRuleEngine({
        afterRuleScript: ({ error }) => {
          if (error) {
            onError(error);
          }
        },
      })
    : sharedRuleEngine;
  return engine.runRuleScript(ctx, script, rule, stateView);
}

export function ruleServesWithoutRequest(rule) {
  return sharedRuleEngine.ruleServesWithoutRequest(rule);
}

export function buildMockResponseContext(rule, requestCtx, stateView) {
  return sharedRuleEngine.buildMockResponseContext(rule, requestCtx, stateView);
}

function ruleNeedsPageHook(rule) {
  if (!rule?.enabled) {
    return false;
  }
  const mod = rule.modify || {};
  return Boolean(
    mod.requestScript?.trim() ||
      mod.responseScript?.trim() ||
      mod.bodyReplacements?.length ||
      rule.action === "block" ||
      rule.action === "redirect" ||
      rule.action === "mock" ||
      ruleServesWithoutRequest(rule) ||
      mod.urlReplacements?.length ||
      mod.headerReplacements?.length ||
      mod.setHeaders?.length
  );
}

export function rulesForPageHook(rules) {
  return (rules || []).filter(ruleNeedsPageHook);
}

export function webRequestHeadersToObject(headers) {
  const out = {};
  if (!headers) {
    return out;
  }
  for (const header of headers) {
    out[header.name] = header.value;
  }
  return out;
}

export function objectToWebRequestHeaders(headers) {
  return Object.entries(headers || {}).map(([name, value]) => ({ name, value }));
}

export function getNetworkHookVersion(state) {
  const payload = {
    enabled: Boolean(state?.enabled),
    sharedState: state?.sharedState || {},
    tabState: state?.tabState || {},
    rules: (state?.rules || [])
      .filter((rule) => rule.enabled)
      .map((rule) => ({
        id: rule.id,
        priority: rule.priority,
        hostPattern: rule.hostPattern,
        pageHostPattern: rule.pageHostPattern,
        pageUrlPattern: rule.pageUrlPattern,
        requestUrlPattern: rule.requestUrlPattern,
        requestContentTypePattern: rule.requestContentTypePattern,
        requestBodyPattern: rule.requestBodyPattern,
        methods: rule.methods,
        resourceTypes: rule.resourceTypes,
        phases: rule.phases,
        responseStatusMin: rule.responseStatusMin,
        responseStatusMax: rule.responseStatusMax,
        action: rule.action,
        redirectUrl: rule.redirectUrl,
        matchHookOriginated: Boolean(rule.matchHookOriginated),
        modify: rule.modify,
      })),
  };
  return JSON.stringify(payload);
}

export function buildNetworkHookMatches() {
  return ["http://*/*", "https://*/*"];
}

function trimLogEntries(entries) {
  return entries.slice(-NETWORK_LOG_LIMIT);
}

/**
 * Append one sanitized entry to a FIFO log queue capped at maxEntries.
 */
export function appendNetworkLogQueue(existing, entry, { maxEntries = NETWORK_LOG_LIMIT } = {}) {
  const sanitized = sanitizeLogEntry(entry);
  if (!sanitized) {
    return existing || [];
  }
  const next = [...(existing || []), sanitized];
  return next.slice(-maxEntries);
}

export function sanitizeLogEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  function pick(key, maxLen) {
    const value = entry[key];
    if (value == null) {
      return undefined;
    }
    return String(value).slice(0, maxLen);
  }

  return {
    ruleId: pick("ruleId", 64),
    ruleName: pick("ruleName", 200),
    phase: pick("phase", 16),
    method: pick("method", 16),
    url: pick("url", 2000),
    pageUrl: pick("pageUrl", 2000),
    resourceType: pick("resourceType", 32),
    outcome: pick("outcome", 32),
    action: pick("action", 16),
    detail: pick("detail", 500),
    via: pick("via", 16),
    tabId: typeof entry.tabId === "number" ? entry.tabId : undefined,
    ts: typeof entry.ts === "number" ? entry.ts : Date.now(),
  };
}

export function isTextLikeContentType(headers) {
  const contentType = String(
    headers?.["Content-Type"] || headers?.["content-type"] || ""
  ).toLowerCase();
  if (!contentType) {
    return false;
  }
  return (
    contentType.includes("text/") ||
    contentType.includes("json") ||
    contentType.includes("javascript") ||
    contentType.includes("xml") ||
    contentType.includes("html") ||
    contentType.includes("x-www-form-urlencoded")
  );
}

export function decodeBasicAuthCredentials(ctx) {
  return sharedRuleEngine.decodeBasicAuthCredentials(ctx);
}

export function matchesNetworkPattern(value, pattern) {
  return sharedRuleEngine.matchesNetworkPattern(value, pattern);
}

export function getHeaderValue(headers, name) {
  return sharedRuleEngine.getHeaderValue(headers, name);
}
