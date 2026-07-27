  const root = typeof globalThis !== "undefined" ? globalThis : window;
  if (root.__snLinksNetworkHook?.version === version) {
    return;
  }

  const persistentState = sharedStateBundle?.persistent
    ? { ...sharedStateBundle.persistent }
    : {};
  const tabState = sharedStateBundle?.tab ? { ...sharedStateBundle.tab } : {};

  const stateView = {
    persistent: persistentState,
    tab: tabState,
  };

  const engine = createSnLinksNetworkRuleEngine({
    resolveBaseUrl: (ctx) => ctx.pageUrl || root.location.href,
    afterRuleScript: ({ error, ctx, rule }) => {
      postSharedStateUpdate();
      if (error) {
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
      }
    },
  });

  const {
    ruleMatches,
    applyModifyReplacements,
    runRuleScript,
    ruleServesWithoutRequest,
    buildMockResponseContext,
    getSortedEnabledRules,
    bodyToString,
  } = engine;

  function attachSharedState(ctx) {
    return engine.attachSharedState(ctx, stateView);
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
    return getSortedEnabledRules(rules);
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
        const snapshot = JSON.stringify({
          url: ctx.url,
          headers: ctx.headers,
          body: ctx.body,
        });
        ctx = applyModifyReplacements(ctx, rule);
        const script =
          phase === "response"
            ? rule.modify?.responseScript
            : rule.modify?.requestScript;
        ctx = runRuleScript(ctx, script, rule, stateView);
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
        const changed =
          JSON.stringify({
            url: ctx.url,
            headers: ctx.headers,
            body: ctx.body,
          }) !== snapshot;
        if (ctx.logDetail || changed) {
          postLog({
            ruleId: rule.id,
            ruleName: rule.name,
            phase,
            method: ctx.method,
            url: ctx.url,
            pageUrl,
            outcome: ctx.logDetail ? "observed" : "modified",
            action: "modify",
            detail: ctx.logDetail,
          });
        }
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
      const mockCtx = buildMockResponseContext(
        mockRule,
        {
          ...requestBase,
          method,
          url,
          body,
          headers,
        },
        stateView
      );
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
      const mockCtx = buildMockResponseContext(
        mockRule,
        {
          method: ctx.method || meta.method,
          url: ctx.url || meta.url,
          body: ctx.body ?? requestBody,
          headers: ctx.headers || meta.headers,
          resourceType: "xmlhttprequest",
        },
        stateView
      );
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

    const nextMethod = ctx.method || meta.method;
    const nextUrl = ctx.url || meta.url;
    const nextHeaders = ctx.headers || meta.headers;
    const urlChanged = nextUrl !== meta.url;
    const methodChanged = nextMethod !== meta.method;
    const headersChanged =
      JSON.stringify(nextHeaders) !== JSON.stringify(meta.headers);

    if (urlChanged || methodChanged || headersChanged) {
      origOpen.call(
        this,
        nextMethod,
        nextUrl,
        meta.async,
        meta.user,
        meta.password
      );
      for (const [name, value] of Object.entries(nextHeaders)) {
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
