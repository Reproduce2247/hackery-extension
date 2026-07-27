(function () {
function createSnLinksNetworkRuleEngine(options = {}) {
  const {
    resolveBaseUrl = (ctx) => ctx.pageUrl || "https://example.invalid/",
    afterRuleScript = () => {},
  } = options;

  const MAX_PATTERN_INPUT_LENGTH = 65536;
  const WILDCARD_PREFIX = "w:";
  const NETWORK_PHASES = ["request", "response"];

  function wildcardPatternToRegExp(pattern) {
    const escaped = pattern
      .replace(/([?.+^${}()|[\]\\])/g, "\\$1")
      .replace(/\*/g, "(.*)");
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
        return wildcardPatternToRegExp(pattern.slice(WILDCARD_PREFIX.length)).test(
          input
        );
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

  function decodeBasicAuthCredentials(ctx) {
    const found = [];

    function addHeaderCred(source, value) {
      if (!value) {
        return;
      }
      const match = String(value).match(/^\s*Basic\s+(\S+)\s*$/i);
      if (!match) {
        return;
      }
      try {
        const decoded = atob(match[1].replace(/-/g, "+").replace(/_/g, "/"));
        const colon = decoded.indexOf(":");
        if (colon < 0) {
          return;
        }
        found.push({
          source,
          username: decoded.slice(0, colon),
          password: decoded.slice(colon + 1),
        });
      } catch {
        // invalid base64
      }
    }

    const headers = ctx.headers || {};
    addHeaderCred("Authorization", getHeaderValue(headers, "Authorization"));
    addHeaderCred(
      "Proxy-Authorization",
      getHeaderValue(headers, "Proxy-Authorization")
    );

    try {
      const url = new URL(ctx.url, resolveBaseUrl(ctx));
      if (url.username || url.password) {
        found.push({
          source: "url",
          username: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        });
      }
    } catch {
      // invalid url
    }

    return found.length ? found : null;
  }

  function ruleMatches(rule, ctx) {
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
      requestUrl = new URL(ctx.url, resolveBaseUrl(ctx));
    } catch {
      return false;
    }

    const pageUrl = ctx.pageUrl || "";

    if (!matchesNetworkPattern(requestUrl.hostname, rule.hostPattern)) {
      return false;
    }
    if (!matchesNetworkPattern(getPageHost(pageUrl), rule.pageHostPattern)) {
      return false;
    }
    if (!matchesNetworkPattern(pageUrl, rule.pageUrlPattern)) {
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
      if (!matchesResourceType(rule, ctx.resourceType || "")) {
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

  function bodyToString(body) {
    if (body == null) {
      return body;
    }
    if (typeof body === "string") {
      return body;
    }
    if (body instanceof URLSearchParams) {
      return body.toString();
    }
    if (typeof body === "object") {
      try {
        return JSON.stringify(body);
      } catch {
        return String(body);
      }
    }
    return String(body);
  }

  function applyModifyReplacements(ctx, rule) {
    const mod = rule.modify || {};
    if (mod.urlReplacements?.length) {
      ctx.url = applyStringReplacements(ctx.url, mod.urlReplacements);
    }
    if (ctx.body != null && mod.bodyReplacements?.length) {
      ctx.body = applyStringReplacements(bodyToString(ctx.body), mod.bodyReplacements);
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

  function attachSharedState(ctx, stateView) {
    ctx.sharedState = stateView.persistent;
    ctx.tabState = stateView.tab;
    return ctx;
  }

  function runRuleScript(ctx, script, rule, stateView) {
    if (stateView) {
      attachSharedState(ctx, stateView);
    }

    if (!script?.trim()) {
      return ctx;
    }

    try {
      const trimmed = script.trim();
      const runner = trimmed.startsWith("function")
        ? new Function(
            "ctx",
            "rule",
            "decodeBasicAuth",
            `return (${trimmed})(ctx, rule, decodeBasicAuth);`
          )
        : new Function("ctx", "rule", "decodeBasicAuth", trimmed);
      const result = runner(ctx, rule, decodeBasicAuthCredentials);
      afterRuleScript({ ctx, rule });
      if (result === null) {
        return null;
      }
      return result || ctx;
    } catch (error) {
      afterRuleScript({ error, ctx, rule });
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
      ctx = applyModifyReplacements(ctx, rule);
      ctx = runRuleScript(ctx, mod.responseScript, rule, stateView);
    }

    return ctx;
  }

  function getSortedEnabledRules(rules) {
    return [...(rules || [])]
      .filter((rule) => rule.enabled)
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }

  return {
    matchesNetworkPattern,
    getPageHost,
    matchesResourceType,
    getHeaderValue,
    decodeBasicAuthCredentials,
    ruleMatches,
    applyStringReplacements,
    bodyToString,
    applyModifyReplacements,
    attachSharedState,
    runRuleScript,
    ruleServesWithoutRequest,
    buildMockResponseContext,
    getSortedEnabledRules,
  };
}

globalThis.createSnLinksNetworkRuleEngine = createSnLinksNetworkRuleEngine;
})();
