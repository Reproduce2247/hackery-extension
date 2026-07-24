const NETWORK_RULES_KEY = "networkRules";
const NETWORK_RULES_LOG_KEY = "networkRulesLog";
const NETWORK_SHARED_STATE_KEY = "networkSharedState";
const NETWORK_TAB_STATE_KEY = "networkTabState";
const NETWORK_HOOKS_ENABLED_KEY = "networkHooksEnabled";
const INJECT_ON_LOAD_ENABLED_KEY = "injectOnLoadEnabled";
const NETWORK_MAIN_HOOK_SCRIPT_ID = "sn-links-network-hook-main";
const NETWORK_LOG_BRIDGE_SCRIPT_ID = "sn-links-network-log-bridge";
const NETWORK_LOG_LIMIT = 100;
const MAX_PATTERN_INPUT_LENGTH = 65536;
const WILDCARD_PREFIX = "w:";

const NETWORK_ACTIONS = ["block", "redirect", "modify", "mock"];
const NETWORK_PHASES = ["request", "response"];
const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

const WEBREQUEST_RESOURCE_TYPES = [
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

function defaultNetworkRulesState() {
  return { enabled: true, rules: [] };
}

function defaultExtensionSettings() {
  return {
    networkHooksEnabled: true,
    injectOnLoadEnabled: true,
  };
}

function createEmptyRule() {
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

function wildcardPatternToRegExp(pattern) {
  const escaped = pattern.replace(/([?.+^${}()|[\]\\])/g, "\\$1").replace(/\*/g, "(.*)");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesNetworkPattern(value, pattern) {
  if (!pattern) {
    return true;
  }
  const input = String(value ?? "");
  if (input.length > MAX_PATTERN_INPUT_LENGTH) {
    return false;
  }
  if (pattern.startsWith(WILDCARD_PREFIX)) {
    try {
      return wildcardPatternToRegExp(pattern.slice(WILDCARD_PREFIX.length)).test(input);
    } catch {
      return false;
    }
  }
  try {
    return new RegExp(pattern, "i").test(input);
  } catch {
    return false;
  }
}

function getPageHost(pageUrl) {
  if (!pageUrl) {
    return "";
  }
  try {
    return new URL(pageUrl).hostname;
  } catch {
    return "";
  }
}

function normalizeMethods(methods) {
  if (!Array.isArray(methods) || methods.length === 0) {
    return null;
  }
  return methods.map((method) => String(method).toUpperCase());
}

function matchesResourceType(rule, resourceType) {
  if (!rule.resourceTypes?.length) {
    return true;
  }
  const type = resourceType || "";
  if (rule.resourceTypes.includes(type)) {
    return true;
  }
  if (type === "fetch" && rule.resourceTypes.includes("xmlhttprequest")) {
    return true;
  }
  if (type === "xmlhttprequest" && rule.resourceTypes.includes("fetch")) {
    return true;
  }
  return false;
}

function getHeaderValue(headers, name) {
  if (!headers) {
    return "";
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return "";
}

function ruleMatchesContext(rule, ctx) {
  if (!rule?.enabled) {
    return false;
  }

  const phases = rule.phases?.length ? rule.phases : NETWORK_PHASES;
  if (!phases.includes(ctx.phase)) {
    return false;
  }

  const methods = normalizeMethods(rule.methods);
  const method = String(ctx.method || "GET").toUpperCase();
  if (methods && !methods.includes(method)) {
    return false;
  }

  let requestUrl;
  try {
    requestUrl = new URL(ctx.url, ctx.pageUrl || "https://example.invalid/");
  } catch {
    return false;
  }

  if (!matchesNetworkPattern(requestUrl.hostname, rule.hostPattern)) {
    return false;
  }
  if (!matchesNetworkPattern(getPageHost(ctx.pageUrl), rule.pageHostPattern)) {
    return false;
  }
  if (!matchesNetworkPattern(ctx.pageUrl || "", rule.pageUrlPattern)) {
    return false;
  }
  if (!matchesNetworkPattern(requestUrl.href, rule.requestUrlPattern)) {
    return false;
  }

  if (
    rule.requestBodyPattern &&
    ctx.phase === "request" &&
    !matchesNetworkPattern(String(ctx.body ?? ""), rule.requestBodyPattern)
  ) {
    return false;
  }

  if (rule.resourceTypes?.length) {
    const resourceType = ctx.resourceType || "";
    if (!matchesResourceType(rule, resourceType)) {
      return false;
    }
  }

  if (
    rule.requestContentTypePattern &&
    ctx.phase === "request" &&
    !matchesNetworkPattern(
      getHeaderValue(ctx.headers, "Content-Type"),
      rule.requestContentTypePattern
    )
  ) {
    return false;
  }

  if (ctx.phase === "response" && ctx.status != null) {
    if (
      rule.responseStatusMin != null &&
      ctx.status < rule.responseStatusMin
    ) {
      return false;
    }
    if (
      rule.responseStatusMax != null &&
      ctx.status > rule.responseStatusMax
    ) {
      return false;
    }
  }

  return true;
}

function applyStringReplacements(value, replacements) {
  if (value == null || !replacements?.length) {
    return value;
  }

  let result = String(value).slice(0, MAX_PATTERN_INPUT_LENGTH);
  for (const replacement of replacements) {
    const find = replacement.find ?? "";
    const replace = replacement.replace ?? "";
    if (!find) {
      continue;
    }
    if (replacement.isRegex) {
      try {
        result = result.replace(new RegExp(find, "g"), replace);
      } catch {
        // invalid regex — skip
      }
    } else {
      result = result.split(find).join(replace);
    }
  }
  return result;
}

function getSortedEnabledRules(rules) {
  return [...(rules || [])]
    .filter((rule) => rule.enabled)
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
}

function getMatchingRules(rules, ctx) {
  return getSortedEnabledRules(rules).filter((rule) => ruleMatchesContext(rule, ctx));
}

function applyModifyReplacementsToContext(ctx, rule) {
  const mod = rule.modify || {};
  if (mod.urlReplacements?.length) {
    ctx.url = applyStringReplacements(ctx.url, mod.urlReplacements);
  }
  if (ctx.body != null && mod.bodyReplacements?.length) {
    ctx.body = applyStringReplacements(String(ctx.body), mod.bodyReplacements);
  }
  if (mod.setHeaders?.length) {
    ctx.headers = ctx.headers || {};
    for (const header of mod.setHeaders) {
      if (header.name) {
        ctx.headers[header.name] = header.value ?? "";
      }
    }
  }
  if (mod.headerReplacements?.length && ctx.headers) {
    for (const [key, value] of Object.entries({ ...ctx.headers })) {
      let next = value;
      for (const replacement of mod.headerReplacements) {
        if (
          replacement.name &&
          replacement.name.toLowerCase() !== key.toLowerCase()
        ) {
          continue;
        }
        next = applyStringReplacements(next, [replacement]);
      }
      ctx.headers[key] = next;
    }
  }
  return ctx;
}

function createSharedStateView(persistentState, tabState) {
  return {
    persistent: persistentState || {},
    tab: tabState || {},
    get shared() {
      return { ...this.persistent, ...this.tab };
    },
  };
}

function attachSharedStateToContext(ctx, stateView) {
  ctx.sharedState = stateView.persistent;
  ctx.tabState = stateView.tab;
  return ctx;
}

function runNetworkRuleScript(ctx, script, rule, onError, stateView) {
  if (stateView) {
    attachSharedStateToContext(ctx, stateView);
  }

  if (!script?.trim()) {
    return ctx;
  }

  try {
    const trimmed = script.trim();
    const runner = trimmed.startsWith("function")
      ? new Function("ctx", "rule", `return (${trimmed})(ctx, rule);`)
      : new Function("ctx", "rule", trimmed);
    const result = runner(ctx, rule);
    if (result === null) {
      return null;
    }
    return result || ctx;
  } catch (error) {
    if (onError) {
      onError(error);
    }
    return ctx;
  }
}

function ruleServesWithoutRequest(rule) {
  if (!rule?.enabled) {
    return false;
  }
  if (rule.action === "mock") {
    return true;
  }
  return Boolean(rule.action === "modify" && rule.modify?.serveWithoutRequest);
}

function buildMockResponseContext(rule, requestCtx, stateView) {
  const mod = rule.modify || {};
  const headers = {};
  for (const header of mod.setHeaders || []) {
    if (header.name) {
      headers[header.name] = header.value ?? "";
    }
  }
  if (!Object.keys(headers).length) {
    headers["Content-Type"] = "text/plain; charset=utf-8";
  }

  let ctx = {
    ...requestCtx,
    phase: "response",
    status: mod.mockStatus ?? 200,
    statusText: mod.mockStatusText ?? "OK",
    body: mod.mockBody ?? "",
    headers,
  };

  if (rule.action === "modify" || rule.action === "mock") {
    ctx = applyModifyReplacementsToContext(ctx, rule);
    ctx = runNetworkRuleScript(
      ctx,
      mod.responseScript,
      rule,
      null,
      stateView
    );
  }

  return ctx;
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

function rulesForPageHook(rules) {
  return (rules || []).filter(ruleNeedsPageHook);
}

function webRequestHeadersToObject(headers) {
  const out = {};
  if (!headers) {
    return out;
  }
  for (const header of headers) {
    out[header.name] = header.value;
  }
  return out;
}

function objectToWebRequestHeaders(headers) {
  return Object.entries(headers || {}).map(([name, value]) => ({ name, value }));
}

function getNetworkHookVersion(state) {
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
        modify: rule.modify,
      })),
  };
  return JSON.stringify(payload);
}

function buildNetworkHookMatches() {
  return ["http://*/*", "https://*/*"];
}

function buildInjectContentScriptMatches() {
  return ["http://*/*", "https://*/*"];
}

function trimLogEntries(entries) {
  return entries.slice(-NETWORK_LOG_LIMIT);
}

function sanitizeLogEntry(entry) {
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
    ts: typeof entry.ts === "number" ? entry.ts : Date.now(),
  };
}

function isTextLikeContentType(headers) {
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
