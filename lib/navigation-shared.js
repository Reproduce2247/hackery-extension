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

async function resolveDerivedUrl(
  node,
  pageUrl,
  paramValues = {},
  { origin = null, tabId = null } = {}
) {
  const { extract, url } = node;
  if (!url) {
    throw new Error("derived-url requires a url template when path is not set.");
  }

  const LM = globalThis.SnLinksLinkModel;
  const entries = LM.normalizeExtractEntries(extract);
  const urlEntries = entries.filter((entry) => entry.kind === "url");
  const domEntries = entries.filter((entry) => entry.kind === "dom");

  if (urlEntries.length > 0 && !pageUrl) {
    throw new Error("Tab has no URL to resolve derived URL against.");
  }
  if (domEntries.length > 0 && !tabId) {
    throw new Error("No target tab for DOM extraction.");
  }

  const values = { ...paramValues };
  const failures = [];
  let extractedAny = false;

  for (const entry of urlEntries) {
    const existing = (values[entry.paramName] ?? "").trim();
    if (existing) {
      continue;
    }

    const value = extractValueFromUrl(entry.pattern, pageUrl);
    if (value) {
      values[entry.paramName] = value;
      extractedAny = true;
      continue;
    }

    const config = LM.getParameterConfig(node, entry.paramName) || {};
    failures.push({ paramName: entry.paramName, optional: Boolean(config.optional) });
  }

  const pendingDomEntries = domEntries.filter((entry) => {
    const existing = (values[entry.paramName] ?? "").trim();
    return !existing;
  });

  if (pendingDomEntries.length > 0) {
    const domValues = await extractValuesFromDom(tabId, pendingDomEntries);
    for (const entry of pendingDomEntries) {
      const value = (domValues[entry.paramName] ?? "").trim();
      if (value) {
        values[entry.paramName] = value;
        extractedAny = true;
        continue;
      }

      const config = LM.getParameterConfig(node, entry.paramName) || {};
      failures.push({ paramName: entry.paramName, optional: Boolean(config.optional) });
    }
  }

  if (failures.length > 0) {
    const requiredFailure = failures.find((failure) => !failure.optional);
    if (requiredFailure) {
      const failedUrl = failures.some((failure) =>
        urlEntries.some((entry) => entry.paramName === failure.paramName)
      );
      if (failedUrl) {
        throw new Error(`URL pattern did not match tab: ${pageUrl}`);
      }
      throw new Error(`Enter a value for ${requiredFailure.paramName}.`);
    }

    if (!extractedAny) {
      return null;
    }

    for (const failure of failures) {
      values[failure.paramName] = "";
    }
  }

  if (origin) {
    values.origin = origin;
  }

  return applyUrlTemplate(url, values);
}

async function resolveDerivedLink(resolved, tab, origin, paramValues) {
  if (resolved.path != null && resolved.path !== "") {
    return resolvePathUrl(resolved.path, tab, origin);
  }
  return resolveDerivedUrl(resolved, tab.url, paramValues, {
    origin,
    tabId: tab?.id ?? null,
  });
}

function evaluateNavScript(source, pageUrl) {
  if (!pageUrl) {
    throw new Error("Tab has no URL to resolve navigation script against.");
  }
  if (!source?.trim()) {
    throw new Error("Navigation script has no code.");
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

function resolveNavScriptletUrl(source, pageUrl, origin, tab = null) {
  const result = evaluateNavScript(source, pageUrl);
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

function resolveNav(node) {
  if (node.nav) {
    return node.nav;
  }
  if (node.type === "navigate") {
    if (isAbsoluteUrl(node.path || "")) {
      return "foreground";
    }
    return "same-tab";
  }
  return null;
}

async function performNavigation(nav, url, tab, hostPattern) {
  if (!url) {
    return;
  }
  if (!nav) {
    throw new Error("Navigation mode is required.");
  }

  switch (nav) {
    case "same-tab":
      if (tab?.id) {
        await browser.tabs.update(tab.id, {
          url,
          active: Boolean(hostPattern),
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
      throw new Error(`Unknown nav mode: ${nav}`);
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
  resolveDerivedLink,
  evaluateNavScript,
  resolveNavScriptletUrl,
  resolveAbsoluteUrl,
  coerceScriptletNavigationUrl,
  resolveNav,
  performNavigation,
};

globalThis.SnLinksNav = SnLinksNav;
})();
