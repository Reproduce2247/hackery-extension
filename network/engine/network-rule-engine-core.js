const WILDCARD_PREFIX = "w:";
const MAX_PATTERN_INPUT_LENGTH = 65536;

function wildcardPatternToRegExp(pattern) {
  const escaped = pattern
    .replace(/([?.+^${}()|[\]\\])/g, "\\$1")
    .replace(/\*/g, "(.*)");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Compile a pattern string into a RegExp, or null when the pattern is empty/absent.
 * Returns { empty, invalid, regex }.
 */
function compilePatternString(pattern) {
  if (!pattern) {
    return { empty: true, invalid: false, regex: null };
  }
  const text = String(pattern);
  if (text.startsWith(WILDCARD_PREFIX)) {
    try {
      return {
        empty: false,
        invalid: false,
        regex: wildcardPatternToRegExp(text.slice(WILDCARD_PREFIX.length)),
      };
    } catch {
      return { empty: false, invalid: true, regex: null };
    }
  }
  try {
    return { empty: false, invalid: false, regex: new RegExp(text, "i") };
  } catch {
    return { empty: false, invalid: true, regex: null };
  }
}

/**
 * Precompile filter patterns and replacement find-regexes for one rule.
 */
function compileRulePatterns(rule) {
  const mod = rule.modify || {};
  return {
    hostPattern: compilePatternString(rule.hostPattern),
    pageHostPattern: compilePatternString(rule.pageHostPattern),
    pageUrlPattern: compilePatternString(rule.pageUrlPattern),
    requestUrlPattern: compilePatternString(rule.requestUrlPattern),
    requestBodyPattern: compilePatternString(rule.requestBodyPattern),
    requestContentTypePattern: compilePatternString(rule.requestContentTypePattern),
    urlReplacements: (mod.urlReplacements || []).map((replacement) => ({
      ...replacement,
      compiledFind: replacement.isRegex
        ? compilePatternString(replacement.find)
        : null,
    })),
    bodyReplacements: (mod.bodyReplacements || []).map((replacement) => ({
      ...replacement,
      compiledFind: replacement.isRegex
        ? compilePatternString(replacement.find)
        : null,
    })),
    headerReplacements: (mod.headerReplacements || []).map((replacement) => ({
      ...replacement,
      compiledFind: replacement.isRegex
        ? compilePatternString(replacement.find)
        : null,
    })),
  };
}

function compileRulesCache(rules) {
  const byId = {};
  for (const rule of rules || []) {
    if (rule?.id) {
      byId[rule.id] = compileRulePatterns(rule);
    }
  }
  return byId;
}

function attachCompiledPatterns(rules, compiledById) {
  return (rules || []).map((rule) => {
    const compiled = compiledById?.[rule.id] || compileRulePatterns(rule);
    return { ...rule, _compiled: compiled };
  });
}

function testCompiledPattern(value, compiled) {
  if (!compiled || compiled.empty) {
    return true;
  }
  if (compiled.invalid || !compiled.regex) {
    return false;
  }
  const input = String(value ?? "");
  if (input.length > MAX_PATTERN_INPUT_LENGTH) {
    return false;
  }
  return compiled.regex.test(input);
}

function createNetworkRuleEngine(options = {}) {
  const {
    resolveBaseUrl = (ctx) => ctx.pageUrl || "https://example.invalid/",
    afterRuleScript = () => {},
  } = options;

  const NETWORK_PHASES = ["request", "response"];

  function matchesNetworkPattern(value, pattern, compiledPattern) {
    if (compiledPattern) {
      return testCompiledPattern(value, compiledPattern);
    }
    if (!pattern) {
      return true;
    }
    return testCompiledPattern(value, compilePatternString(pattern));
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
    const compiled = rule._compiled;

    if (
      !matchesNetworkPattern(
        requestUrl.hostname,
        rule.hostPattern,
        compiled?.hostPattern
      )
    ) {
      return false;
    }
    if (
      !matchesNetworkPattern(
        getPageHost(pageUrl),
        rule.pageHostPattern,
        compiled?.pageHostPattern
      )
    ) {
      return false;
    }
    if (
      !matchesNetworkPattern(pageUrl, rule.pageUrlPattern, compiled?.pageUrlPattern)
    ) {
      return false;
    }
    if (
      !matchesNetworkPattern(
        requestUrl.href,
        rule.requestUrlPattern,
        compiled?.requestUrlPattern
      )
    ) {
      return false;
    }

    if (rule.requestBodyPattern && ctx.phase === "request") {
      if (
        !matchesNetworkPattern(
          String(ctx.body ?? ""),
          rule.requestBodyPattern,
          compiled?.requestBodyPattern
        )
      ) {
        return false;
      }
    }

    if (rule.resourceTypes?.length) {
      if (!matchesResourceType(rule, ctx.resourceType || "")) {
        return false;
      }
    }

    if (rule.requestContentTypePattern && ctx.phase === "request") {
      if (
        !matchesNetworkPattern(
          getHeaderValue(ctx.headers, "Content-Type"),
          rule.requestContentTypePattern,
          compiled?.requestContentTypePattern
        )
      ) {
        return false;
      }
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

  function applyStringReplacements(value, replacements, compiledReplacements) {
    if (value == null || !replacements?.length) {
      return value;
    }

    let result = String(value).slice(0, MAX_PATTERN_INPUT_LENGTH);
    for (let index = 0; index < replacements.length; index += 1) {
      const replacement = replacements[index];
      const compiledReplacement = compiledReplacements?.[index];
      const find = replacement.find ?? "";
      const replace = replacement.replace ?? "";
      if (!find) {
        continue;
      }
      if (replacement.isRegex) {
        const compiledFind =
          compiledReplacement?.compiledFind || compilePatternString(find);
        if (compiledFind.invalid || !compiledFind.regex) {
          continue;
        }
        result = result.replace(compiledFind.regex, replace);
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
    const compiled = rule._compiled;
    if (mod.urlReplacements?.length) {
      ctx.url = applyStringReplacements(
        ctx.url,
        mod.urlReplacements,
        compiled?.urlReplacements
      );
    }
    if (ctx.body != null && mod.bodyReplacements?.length) {
      ctx.body = applyStringReplacements(
        bodyToString(ctx.body),
        mod.bodyReplacements,
        compiled?.bodyReplacements
      );
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
          const compiledHeader = compiled?.headerReplacements?.find(
            (entry) => entry.find === replacement.find && entry.name === replacement.name
          );
          next = applyStringReplacements(next, [replacement], compiledHeader ? [compiledHeader] : null);
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
    WILDCARD_PREFIX,
    compilePatternString,
    compileRulePatterns,
    compileRulesCache,
    attachCompiledPatterns,
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

export {
  createNetworkRuleEngine,
  compileRulePatterns as compileNetworkRulePatterns,
  compileRulesCache as compileNetworkRulesCache,
  attachCompiledPatterns as attachCompiledNetworkRules,
};
