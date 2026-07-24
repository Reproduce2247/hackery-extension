/* global installNetworkHook */

function installNetworkHook(rules, version, logToken, sharedStateBundle) {
  const root = typeof globalThis !== "undefined" ? globalThis : window;
  if (root.__snLinksNetworkHook?.version === version) {
    return;
  }

  const MAX_PATTERN_INPUT_LENGTH = 65536;
  const WILDCARD_PREFIX = "w:";

  const persistentState = sharedStateBundle?.persistent
    ? { ...sharedStateBundle.persistent }
    : {};
  const tabState = sharedStateBundle?.tab ? { ...sharedStateBundle.tab } : {};

  const stateView = {
    persistent: persistentState,
    tab: tabState,
  };

  function wildcardPatternToRegExp(pattern) {
    const escaped = pattern
      .replace(/([?.+^${}()|[\]\\])/g, "\\$1")
      .replace(/\*/g, "(.*)");
    return new RegExp(`^${escaped}$`, "i");
  }

  function matchesPattern(value, pattern) {
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

  function getHeader(headers, name) {
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

  function attachSharedState(ctx) {
    ctx.sharedState = stateView.persistent;
    ctx.tabState = stateView.tab;
    return ctx;
  }

  function postSharedStateUpdate() {
    root.postMessage(
      {
        source: "sn-links-network-hook",
        type: "sharedState",
        token: logToken,
        persistent: stateView.persistent,
        tab: stateView.tab,
      },
      "*"
    );
  }

  function ruleMatches(rule, ctx) {
    if (!rule?.enabled) {
      return false;
    }

    const phases = rule.phases?.length ? rule.phases : ["request", "response"];
    if (!phases.includes(ctx.phase)) {
      return false;
    }

    const methods = rule.methods?.length
      ? rule.methods.map((method) => String(method).toUpperCase())
      : null;
    const method = String(ctx.method || "GET").toUpperCase();
    if (methods && !methods.includes(method)) {
      return false;
    }

    let requestUrl;
    try {
      requestUrl = new URL(ctx.url, ctx.pageUrl || root.location.href);
    } catch {
      return false;
    }

    if (!matchesPattern(requestUrl.hostname, rule.hostPattern)) {
      return false;
    }
    if (!matchesPattern(getPageHost(ctx.pageUrl || root.location.href), rule.pageHostPattern)) {
      return false;
    }
    if (!matchesPattern(ctx.pageUrl || root.location.href, rule.pageUrlPattern)) {
      return false;
    }
    if (!matchesPattern(requestUrl.href, rule.requestUrlPattern)) {
      return false;
    }

    if (
      rule.requestBodyPattern &&
      ctx.phase === "request" &&
      !matchesPattern(String(ctx.body ?? ""), rule.requestBodyPattern)
    ) {
      return false;
    }

    if (!matchesResourceType(rule, ctx.resourceType || "")) {
      return false;
    }

    if (
      rule.requestContentTypePattern &&
      ctx.phase === "request" &&
      !matchesPattern(
        getHeader(ctx.headers, "Content-Type"),
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

  function ruleServesWithoutRequest(rule) {
    if (!rule?.enabled) {
      return false;
    }
    if (rule.action === "mock") {
      return true;
    }
    return Boolean(rule.action === "modify" && rule.modify?.serveWithoutRequest);
  }

  function applyReplacements(value, replacements) {
    if (value == null || !replacements?.length) {
      return value;
    }

    let result = String(value);
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
          // skip invalid regex
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
      ctx.url = applyReplacements(ctx.url, mod.urlReplacements);
    }
    if (ctx.body != null && mod.bodyReplacements?.length) {
      ctx.body = applyReplacements(bodyToString(ctx.body), mod.bodyReplacements);
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
          next = applyReplacements(next, [replacement]);
        }
        ctx.headers[key] = next;
      }
    }
    return ctx;
  }

  function runModifyScript(ctx, script, rule) {
    if (!script?.trim()) {
      return ctx;
    }

    attachSharedState(ctx);

    try {
      const trimmed = script.trim();
      const runner = trimmed.startsWith("function")
        ? new Function("ctx", "rule", `return (${trimmed})(ctx, rule);`)
        : new Function("ctx", "rule", trimmed);
      const result = runner(ctx, rule);
      postSharedStateUpdate();
      if (result === null) {
        return null;
      }
      return result || ctx;
    } catch (error) {
      postLog({
        ruleId: rule.id,
        ruleName: rule.name,
        phase: ctx.phase,
        method: ctx.method,
        url: ctx.url,
        pageUrl: ctx.pageUrl,
        outcome: "error",
        detail: String(error),
      });
      return ctx;
    }
  }

  function postLog(entry) {
    root.postMessage(
      {
        source: "sn-links-network-hook",
        type: "log",
        token: logToken,
        entry: { ...entry, ts: Date.now() },
      },
      "*"
    );
  }

  function sortedRules() {
    return [...rules]
      .filter((rule) => rule.enabled)
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }

  function findMockRule(requestCtx) {
    for (const rule of sortedRules()) {
      if (!ruleServesWithoutRequest(rule)) {
        continue;
      }
      if (ruleMatches(rule, { ...requestCtx, phase: "request" })) {
        return rule;
      }
    }
    return null;
  }

  function buildMockResponseContext(rule, requestCtx) {
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

    ctx = applyModifyReplacements(ctx, rule);
    ctx = runModifyScript(ctx, mod.responseScript, rule);
    return ctx;
  }

  function processRules(phase, baseCtx) {
    const pageUrl = root.location.href;
    let ctx = attachSharedState({ ...baseCtx, phase, pageUrl });

    for (const rule of sortedRules()) {
      if (!ruleMatches(rule, ctx)) {
        continue;
      }

      if (rule.action === "block") {
        postLog({
          ruleId: rule.id,
          ruleName: rule.name,
          phase,
          method: ctx.method,
          url: ctx.url,
          pageUrl,
          outcome: "blocked",
          action: "block",
        });
        return null;
      }

      if (rule.action === "redirect" && rule.redirectUrl) {
        ctx.url = rule.redirectUrl;
        postLog({
          ruleId: rule.id,
          ruleName: rule.name,
          phase,
          method: ctx.method,
          url: ctx.url,
          pageUrl,
          outcome: "redirect",
          action: "redirect",
        });
        continue;
      }

      if (rule.action === "mock") {
        continue;
      }

      if (rule.action === "modify") {
        if (rule.modify?.serveWithoutRequest) {
          continue;
        }
        ctx = applyModifyReplacements(ctx, rule);
        const script =
          phase === "response"
            ? rule.modify?.responseScript
            : rule.modify?.requestScript;
        ctx = runModifyScript(ctx, script, rule);
        if (ctx === null) {
          postLog({
            ruleId: rule.id,
            ruleName: rule.name,
            phase,
            method: baseCtx.method,
            url: baseCtx.url,
            pageUrl,
            outcome: "blocked",
            action: "modify",
          });
          return null;
        }
        postLog({
          ruleId: rule.id,
          ruleName: rule.name,
          phase,
          method: ctx.method,
          url: ctx.url,
          pageUrl,
          outcome: "modified",
          action: "modify",
        });
      }
    }

    return ctx;
  }

  function headersToObject(headers) {
    const out = {};
    if (!headers) {
      return out;
    }
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        out[key] = value;
      });
      return out;
    }
    if (Array.isArray(headers)) {
      for (const [key, value] of headers) {
        out[key] = value;
      }
      return out;
    }
    return { ...headers };
  }

  function objectToHeaders(headers) {
    const next = new Headers();
    for (const [key, value] of Object.entries(headers || {})) {
      next.set(key, value);
    }
    return next;
  }

  function parseXhrResponseHeaders(raw) {
    const headers = {};
    if (!raw) {
      return headers;
    }
    for (const line of raw.trim().split(/[\r\n]+/)) {
      const index = line.indexOf(":");
      if (index === -1) {
        continue;
      }
      headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    return headers;
  }

  function deliverMockXhr(xhr, mockCtx, rule, requestCtx) {
    const pageUrl = root.location.href;
    postLog({
      ruleId: rule.id,
      ruleName: rule.name,
      phase: "response",
      method: requestCtx.method,
      url: requestCtx.url,
      pageUrl,
      outcome: "mocked",
      action: rule.action,
    });

    const status = mockCtx?.status ?? 200;
    const body = mockCtx?.body ?? "";
    const statusText = mockCtx?.statusText ?? "OK";

    Object.defineProperty(xhr, "status", { configurable: true, value: status });
    Object.defineProperty(xhr, "statusText", {
      configurable: true,
      value: statusText,
    });
    Object.defineProperty(xhr, "responseText", {
      configurable: true,
      get() {
        return body;
      },
    });
    Object.defineProperty(xhr, "response", {
      configurable: true,
      get() {
        return body;
      },
    });
    Object.defineProperty(xhr, "readyState", {
      configurable: true,
      writable: true,
      value: 4,
    });

    root.setTimeout(() => {
      xhr.dispatchEvent(new ProgressEvent("loadstart"));
      xhr.dispatchEvent(new Event("readystatechange"));
      xhr.dispatchEvent(new ProgressEvent("load"));
      xhr.dispatchEvent(new ProgressEvent("loadend"));
    }, 0);
  }

  const origFetch = root.fetch.bind(root);
  root.fetch = async function snLinksFetch(input, init) {
    const request = input instanceof Request ? input : null;
    let url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : request.url;
    const baseInit = init ? { ...init } : {};
    let method = (
      baseInit.method ||
      request?.method ||
      "GET"
    ).toUpperCase();
    let body = baseInit.body ?? undefined;
    let headers = headersToObject(baseInit.headers || request?.headers);

    if (body != null && typeof body !== "string") {
      body = bodyToString(body);
    }

    const requestBase = {
      method,
      url,
      body,
      headers,
      resourceType: "fetch",
    };

    let ctx = processRules("request", requestBase);
    if (ctx === null) {
      throw new DOMException("Blocked by network rule", "AbortError");
    }

    method = ctx.method || method;
    url = ctx.url || url;
    body = ctx.body ?? body;
    headers = ctx.headers || headers;

    const mockRule = findMockRule({
      ...requestBase,
      method,
      url,
      body,
      headers,
    });
    if (mockRule) {
      const mockCtx = buildMockResponseContext(mockRule, {
        ...requestBase,
        method,
        url,
        body,
        headers,
      });
      if (mockCtx === null) {
        throw new DOMException("Blocked by network rule", "AbortError");
      }
      postLog({
        ruleId: mockRule.id,
        ruleName: mockRule.name,
        phase: "response",
        method,
        url,
        pageUrl: root.location.href,
        outcome: "mocked",
        action: mockRule.action,
      });
      return new Response(mockCtx.body ?? "", {
        status: mockCtx.status ?? 200,
        statusText: mockCtx.statusText ?? "OK",
        headers: objectToHeaders(mockCtx.headers),
      });
    }

    const response = await origFetch(url, {
      ...baseInit,
      method,
      body,
      headers,
    });

    let responseBody = await response.clone().text();
    const responseCtx = processRules("response", {
      method,
      url,
      status: response.status,
      headers: headersToObject(response.headers),
      body: responseBody,
      resourceType: "fetch",
    });

    if (responseCtx === null) {
      throw new DOMException("Blocked by network rule", "AbortError");
    }

    const nextStatus = responseCtx.status ?? response.status;
    const nextHeaders = responseCtx.headers
      ? objectToHeaders(responseCtx.headers)
      : response.headers;
    const nextBody = responseCtx.body ?? responseBody;

    return new Response(nextBody, {
      status: nextStatus,
      statusText: response.statusText,
      headers: nextHeaders,
    });
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function snLinksOpen(
    method,
    url,
    async,
    user,
    password
  ) {
    this.__snLinks = {
      method: String(method || "GET").toUpperCase(),
      url: String(url),
      async: async !== false,
      user,
      password,
      headers: {},
    };
    return origOpen.call(this, method, url, async, user, password);
  };

  XMLHttpRequest.prototype.setRequestHeader = function snLinksSetHeader(
    name,
    value
  ) {
    if (this.__snLinks) {
      this.__snLinks.headers[name] = value;
    }
    return origSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function snLinksSend(body) {
    const meta = this.__snLinks || {
      method: "GET",
      url: "",
      headers: {},
    };

    const requestBody =
      body != null && typeof body !== "string" ? bodyToString(body) : body;

    let ctx = processRules("request", {
      method: meta.method,
      url: meta.url,
      body: requestBody,
      headers: { ...meta.headers },
      resourceType: "xmlhttprequest",
    });
    if (ctx === null) {
      root.setTimeout(() => {
        this.dispatchEvent(new ProgressEvent("error"));
      }, 0);
      return;
    }

    const mockRule = findMockRule({
      method: ctx.method || meta.method,
      url: ctx.url || meta.url,
      body: ctx.body ?? requestBody,
      headers: ctx.headers || meta.headers,
      resourceType: "xmlhttprequest",
    });
    if (mockRule) {
      const mockCtx = buildMockResponseContext(mockRule, {
        method: ctx.method || meta.method,
        url: ctx.url || meta.url,
        body: ctx.body ?? requestBody,
        headers: ctx.headers || meta.headers,
        resourceType: "xmlhttprequest",
      });
      if (mockCtx === null) {
        root.setTimeout(() => {
          this.dispatchEvent(new ProgressEvent("error"));
        }, 0);
        return;
      }
      deliverMockXhr(this, mockCtx, mockRule, {
        method: ctx.method || meta.method,
        url: ctx.url || meta.url,
      });
      return;
    }

    if (ctx.url && ctx.url !== meta.url) {
      origOpen.call(
        this,
        ctx.method || meta.method,
        ctx.url,
        meta.async,
        meta.user,
        meta.password
      );
      for (const [name, value] of Object.entries(ctx.headers || {})) {
        origSetRequestHeader.call(this, name, value);
      }
    } else if (ctx.headers) {
      for (const [name, value] of Object.entries(ctx.headers)) {
        origSetRequestHeader.call(this, name, value);
      }
    }

    const xhr = this;
    const origReady = xhr.onreadystatechange;
    xhr.onreadystatechange = function snLinksReadyState() {
      if (xhr.readyState === 4) {
        try {
          const responseCtx = processRules("response", {
            method: ctx.method || meta.method,
            url: ctx.url || meta.url,
            status: xhr.status,
            headers: parseXhrResponseHeaders(xhr.getAllResponseHeaders()),
            body: xhr.responseText,
            resourceType: "xmlhttprequest",
          });
          if (
            responseCtx &&
            responseCtx.body != null &&
            responseCtx.body !== xhr.responseText
          ) {
            Object.defineProperty(xhr, "responseText", {
              configurable: true,
              get() {
                return responseCtx.body;
              },
            });
            Object.defineProperty(xhr, "response", {
              configurable: true,
              get() {
                return responseCtx.body;
              },
            });
          }
        } catch {
          // response rewrite failed — leave original
        }
      }
      if (typeof origReady === "function") {
        origReady.apply(this, arguments);
      }
    };

    return origSend.call(this, ctx.body ?? requestBody);
  };

  root.__snLinksNetworkHook = { version, rulesCount: rules.length };
}

function buildMainHookBootstrap(rules, version, logToken, sharedStateBundle) {
  return `(function(){var rules=${JSON.stringify(rules)};var version=${JSON.stringify(version)};var logToken=${JSON.stringify(logToken)};var sharedStateBundle=${JSON.stringify(sharedStateBundle)};(${installNetworkHook.toString()})(rules,version,logToken,sharedStateBundle);})();`;
}

function buildLogBridgeBootstrap(logToken) {
  return `(function(){var LOG_TOKEN=${JSON.stringify(logToken)};window.addEventListener("message",function(event){if(event.source!==window)return;var data=event.data;if(!data||data.source!=="sn-links-network-hook"||data.token!==LOG_TOKEN)return;if(data.type==="log"){browser.runtime.sendMessage({type:"NETWORK_RULE_LOG",entry:data.entry}).catch(function(){});return;}if(data.type==="sharedState"){browser.runtime.sendMessage({type:"NETWORK_SHARED_STATE",persistent:data.persistent,tab:data.tab}).catch(function(){});}});})();`;
}
