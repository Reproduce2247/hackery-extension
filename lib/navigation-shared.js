(function () {
const NAV_TARGET_PREFIX = /^now\/nav\/ui\/classic\/params\/target\//;

function toNavigatorPath(path) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const parsed = new URL(normalized, "https://example.service-now.com");
  const barePath = parsed.pathname.replace(/^\/+/, "");

  if (NAV_TARGET_PREFIX.test(barePath)) {
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  const target = encodeURIComponent(barePath + parsed.search + parsed.hash);
  return `/now/nav/ui/classic/params/target/${target}`;
}

function toNavigatorUrl(origin, path) {
  return `${origin}${toNavigatorPath(path)}`;
}

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

function resolveDerivedUrl(
  { extract, url, parameter },
  pageUrl,
  paramValues = {},
  { origin = null } = {}
) {
  if (!url) {
    throw new Error("derived-url requires a url template when path is not set.");
  }
  if (extract && !pageUrl) {
    throw new Error("Tab has no URL to resolve derived URL against.");
  }

  const paramName = parameter?.name || "id";
  let value = (paramValues[paramName] ?? "").trim();
  if (!value && extract) {
    const match = pageUrl.match(new RegExp(extract, "i"));
    if (!match) {
      if (parameter?.optional) {
        return null;
      }
      throw new Error(`URL pattern did not match tab: ${pageUrl}`);
    }
    value = match[1] || "";
  }
  if (!value && extract) {
    if (parameter?.optional) {
      return null;
    }
    throw new Error(`Enter a value for ${paramName}.`);
  }

  const values = { ...paramValues };
  if (value) {
    values[paramName] = value;
  }
  if (origin) {
    values.origin = origin;
  }

  return applyUrlTemplate(url, values);
}

function resolveDerivedLink(resolved, tab, origin, hostPattern, paramValues) {
  if (resolved.path != null && resolved.path !== "") {
    return resolvePathUrl(resolved.path, tab, origin, hostPattern);
  }
  return resolveDerivedUrl(resolved, tab.url, paramValues, { origin });
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
  return new Function("location", `return (${source})`)(location);
}

function resolveAbsoluteUrl(urlOrPath, tab, origin, hostPattern) {
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
  const absolute = new URL(text, base).href;
  if (hostPattern) {
    const parsed = new URL(absolute);
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return toNavigatorUrl(origin, path);
  }
  return absolute;
}

function isAbsoluteUrl(path) {
  return /^https?:\/\//i.test(path || "");
}

function resolvePathUrl(path, tab, origin, hostPattern) {
  if (isAbsoluteUrl(path)) {
    return path;
  }
  if (hostPattern) {
    return toNavigatorUrl(origin, path);
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
  toNavigatorPath,
  toNavigatorUrl,
  resolvePathOnTab,
  isAbsoluteUrl,
  resolvePathUrl,
  applyUrlTemplate,
  resolveDerivedUrl,
  resolveDerivedLink,
  evaluateNavScript,
  resolveAbsoluteUrl,
  resolveNav,
  performNavigation,
};

globalThis.SnLinksNav = SnLinksNav;
})();
