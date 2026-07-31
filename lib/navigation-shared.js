(function () {
function resolvePathOnTab(tab, path) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  if (!tab?.url) {
    throw new Error("Active tab has no URL to resolve path against.");
  }
  return new URL(path, tab.url).href;
}

function applyUrlTemplate(template, values) {
  return globalThis.SnLinksLinkModel.applyTemplate(template, values, {
    encode: true,
  });
}

function extractValueFromUrl(pattern, pageUrl) {
  const match = pageUrl.match(new RegExp(pattern, "i"));
  return match ? match[1] || "" : "";
}

async function extractValuesFromDom(tabId, domEntries) {
  if (!tabId) {
    throw new Error("No target tab for DOM extraction.");
  }
  if (domEntries.length === 0) {
    return {};
  }

  const [{ result }] = await browser.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (specs) => {
      const values = {};
      for (const spec of specs) {
        const element = document.querySelector(spec.selector);
        if (!element) {
          values[spec.paramName] = "";
          continue;
        }
        let raw;
        switch (spec.stringSource) {
          case "innerHTML":
            raw = element.innerHTML;
            break;
          case "textContent":
            raw = element.textContent;
            break;
          case "id":
            raw = element.id;
            break;
          case "attribute":
            raw = element.getAttribute(spec.attribute);
            break;
          default:
            raw = element.textContent;
        }
        values[spec.paramName] = raw == null ? "" : String(raw).trim();
      }
      return values;
    },
    args: [
      domEntries.map(({ paramName, selector, stringSource, attribute }) => ({
        paramName,
        selector,
        stringSource,
        attribute,
      })),
    ],
  });

  return result || {};
}

/**
 * Resolve URL template values: non-empty manual → derivation → default.
 * Missing required values → null (no-op). optional: true allows empty.
 */
async function resolveDerivedUrl(
  node,
  pageUrl,
  paramValues = {},
  { origin = null, tabId = null } = {}
) {
  const { url } = node;
  if (!url) {
    throw new Error("URL action requires a url template.");
  }

  const LM = globalThis.SnLinksLinkModel;
  const defs = LM.getNavParamDefs(node);
  const entries = LM.normalizeNavParamDerivations(LM.getNavParamsObject(node));
  const urlEntries = entries.filter((entry) => entry.kind === "url");
  const domEntries = entries.filter((entry) => entry.kind === "dom");

  if (urlEntries.length > 0 && !pageUrl) {
    throw new Error("Tab has no URL to resolve derived URL against.");
  }
  if (domEntries.length > 0 && !tabId) {
    throw new Error("No target tab for DOM extraction.");
  }

  // Manual seed only — blank must not block derivation.
  const values = LM.seedNavParamValues(defs, paramValues);

  for (const entry of urlEntries) {
    if ((values[entry.paramName] ?? "").trim()) {
      continue;
    }
    const value = extractValueFromUrl(entry.pattern, pageUrl);
    if (value) {
      values[entry.paramName] = value;
    }
  }

  const pendingDomEntries = domEntries.filter(
    (entry) => !(values[entry.paramName] ?? "").trim()
  );
  if (pendingDomEntries.length > 0) {
    const domValues = await extractValuesFromDom(tabId, pendingDomEntries);
    for (const entry of pendingDomEntries) {
      const value = (domValues[entry.paramName] ?? "").trim();
      if (value) {
        values[entry.paramName] = value;
      }
    }
  }

  for (const def of defs) {
    if ((values[def.name] ?? "").trim()) {
      continue;
    }
    if (def.default !== "" && def.default !== undefined) {
      values[def.name] = def.default;
    }
  }

  for (const def of defs) {
    if ((values[def.name] ?? "").trim()) {
      continue;
    }
    if (def.optional) {
      values[def.name] = "";
      continue;
    }
    return null;
  }

  if (origin) {
    values.origin = origin;
  }

  return applyUrlTemplate(url, values);
}

function urlHasTemplateTokens(url) {
  return /\{[^}]+\}/.test(url || "");
}

function urlHasNavParams(node) {
  const navParams = globalThis.SnLinksLinkModel.getNavParamsObject(node);
  return navParams && Object.keys(navParams).length > 0;
}

/** @deprecated use urlHasNavParams */
function urlHasExtract(node) {
  return urlHasNavParams(node);
}

async function resolveUrlAction(node, tab, origin, paramValues = {}) {
  const urlTemplate = node.url;
  if (!urlTemplate) {
    throw new Error("URL action requires url.");
  }

  if (urlHasNavParams(node) || urlHasTemplateTokens(urlTemplate)) {
    return resolveDerivedUrl(node, tab?.url, paramValues, {
      origin,
      tabId: tab?.id ?? null,
    });
  }

  return resolvePathUrl(urlTemplate, tab, origin);
}

function evaluateNavScript(source, pageUrl, paramValues = {}) {
  if (!pageUrl) {
    throw new Error("Tab has no URL to resolve navigation script against.");
  }
  if (!source?.trim()) {
    throw new Error("Navigation script has no code.");
  }
  const names = Object.keys(paramValues);
  const values = names.map((name) => paramValues[name]);
  if (names.length) {
    return new Function(...names, source)(...values);
  }
  const parsed = new URL(pageUrl);
  const location = {
    href: parsed.href,
    origin: parsed.origin,
    pathname: parsed.pathname,
    hostname: parsed.hostname,
    search: parsed.search,
    hash: parsed.hash,
  };
  return new Function("location", source)(location);
}

function resolveNavScriptletUrl(source, pageUrl, origin, tab = null, paramValues = {}) {
  const result = evaluateNavScript(source, pageUrl, paramValues);
  return coerceScriptletNavigationUrl(result, tab || { url: pageUrl }, origin);
}

function resolveAbsoluteUrl(urlOrPath, tab, origin) {
  if (urlOrPath == null || urlOrPath === "") {
    return null;
  }
  const text = String(urlOrPath);
  if (/^https?:\/\//i.test(text)) {
    return text;
  }
  const base = origin || tab?.url;
  if (!base) {
    throw new Error("No origin to resolve URL against.");
  }
  return new URL(text, base).href;
}

function coerceScriptletNavigationUrl(value, tab, origin) {
  if (value == null || value === "") {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  return resolveAbsoluteUrl(text, tab, origin);
}

function isAbsoluteUrl(path) {
  return /^https?:\/\//i.test(path || "");
}

function resolvePathUrl(path, tab, origin) {
  if (isAbsoluteUrl(path)) {
    return path;
  }
  if (origin) {
    return new URL(path, origin).href;
  }
  return resolvePathOnTab(tab, path);
}

function normalizeOpenForNav(open) {
  if (open === "tab") {
    return "foreground";
  }
  if (open === "download") {
    return "fetch";
  }
  return open;
}

function resolveOpen(node) {
  return node.open || null;
}

/** @deprecated use resolveOpen */
function resolveNav(node) {
  return resolveOpen(node);
}

async function performNavigation(nav, url, tab, matchPattern) {
  if (!url) {
    return;
  }
  if (!nav) {
    throw new Error("Navigation mode is required.");
  }

  const mode = normalizeOpenForNav(nav);

  switch (mode) {
    case "same-tab":
      if (tab?.id) {
        await browser.tabs.update(tab.id, {
          url,
          active: Boolean(matchPattern),
        });
      } else {
        await browser.tabs.create({ url, active: true });
      }
      return;
    case "foreground":
      await browser.tabs.create({ url, active: true });
      return;
    case "background":
      await browser.tabs.create({ url, active: false });
      return;
    case "fetch":
      await browser.downloads.download({ url });
      return;
    default:
      throw new Error(`Unknown open mode: ${nav}`);
  }
}

const SnLinksNav = {
  resolvePathOnTab,
  isAbsoluteUrl,
  resolvePathUrl,
  applyUrlTemplate,
  extractValueFromUrl,
  extractValuesFromDom,
  resolveDerivedUrl,
  resolveUrlAction,
  evaluateNavScript,
  resolveNavScriptletUrl,
  resolveAbsoluteUrl,
  coerceScriptletNavigationUrl,
  normalizeOpenForNav,
  resolveOpen,
  resolveNav,
  performNavigation,
};

globalThis.SnLinksNav = SnLinksNav;
})();
