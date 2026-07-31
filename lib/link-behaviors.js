(function () {
const Nav = () => globalThis.SnLinksNav;
const LM = () => globalThis.SnLinksLinkModel;

function urlHasTemplateTokens(url) {
  return /\{[^}]+\}/.test(url || "");
}

function urlHasNavParams(node) {
  const navParams = LM().getNavParamsObject?.(node);
  return navParams && Object.keys(navParams).length > 0;
}

function isUrlDerived(node) {
  return urlHasNavParams(node) || urlHasTemplateTokens(node.url);
}

/** Short label for how a URL action opens (same tab / new tab / …). */
function openModeLabel(open) {
  switch (open) {
    case "same-tab":
      return "Same tab";
    case "tab":
    case "foreground":
      return "New tab";
    case "background":
      return "Background tab";
    case "download":
    case "fetch":
      return "Download";
    default:
      return "";
  }
}

function previewUrlHint(url) {
  return (url || "")
    .replace(/\{encode:[^}]+\}/g, "…")
    .replace(/\{[^}]+\}/g, "…");
}

function formatOpenHint(open, urlPreview) {
  const mode = openModeLabel(open);
  const preview = previewUrlHint(urlPreview);
  if (mode && preview) {
    return `${mode} · ${preview}`;
  }
  return mode || preview || "";
}

const behaviors = [
  {
    id: "open-from-script",
    when(node) {
      return Boolean(node.code && node.open);
    },
    badge(node) {
      return {
        label: "Open",
        className: "link-badge nav-scriptlet",
      };
    },
    hint(node) {
      return openModeLabel(node.open) || null;
    },
    async run(node, ctx) {
      const { tab, origin, paramValues, executeScriptlet } = ctx;
      const returnValue = await executeScriptlet(tab.id, node.code, paramValues);
      const url = Nav().coerceScriptletNavigationUrl(returnValue, tab, origin);
      if (!url) {
        throw new Error("Navigation script did not resolve to a URL.");
      }
      await Nav().performNavigation(
        Nav().normalizeOpenForNav(node.open),
        url,
        tab,
        node.match ?? null
      );
      return { navigated: true, url };
    },
  },
  {
    id: "open-url",
    when(node) {
      return Boolean(node.url);
    },
    badge(node) {
      if (isUrlDerived(node)) {
        return { label: "Derive", className: "link-badge derived-url" };
      }
      if (Nav().isAbsoluteUrl(node.url)) {
        return { label: "Web", className: "link-badge absolute-url" };
      }
      return { label: "Open", className: "link-badge" };
    },
    hint(node, paramValues = {}) {
      const resolved = LM().resolveNode(node, paramValues);
      return formatOpenHint(node.open, resolved.url || "");
    },
    async run(node, ctx) {
      const { tab, origin, paramValues } = ctx;
      const url = await Nav().resolveUrlAction(node, tab, origin, paramValues);
      if (url === null) {
        return { navigated: false, url: null };
      }
      const open = node.open;
      if (!open) {
        throw new Error(`URL action "${node.name}" requires open.`);
      }
      await Nav().performNavigation(
        Nav().normalizeOpenForNav(open),
        url,
        tab,
        node.match ?? null
      );
      return { navigated: true, url };
    },
  },
  {
    id: "run",
    when(node) {
      return Boolean(node.code);
    },
    badge() {
      return { label: "Run", className: "link-badge" };
    },
    hint(node) {
      return node.match
        ? "Runs on the matched host tab"
        : "Runs on the active tab";
    },
    async run(node, ctx) {
      const { tab, paramValues, executeScriptlet } = ctx;
      await executeScriptlet(tab.id, node.code, paramValues);
      return { ran: true };
    },
  },
];

function matchBehavior(node) {
  for (const behavior of behaviors) {
    if (behavior.when(node)) {
      return behavior;
    }
  }
  return null;
}

function linkBadgeLabel(node) {
  const behavior = matchBehavior(node);
  return behavior ? behavior.badge(node).label : "Open";
}

function linkBadgeClass(node) {
  const behavior = matchBehavior(node);
  return behavior ? behavior.badge(node).className : "link-badge";
}

function displayHint(node, paramValues = {}) {
  const behavior = matchBehavior(node);
  if (!behavior?.hint) {
    return "";
  }
  return behavior.hint(node, paramValues) ?? "";
}

function supportsOnLoad(node) {
  const behavior = matchBehavior(node);
  return behavior?.id === "run";
}

const SnLinksBehaviors = {
  behaviors,
  matchBehavior,
  linkBadgeLabel,
  linkBadgeClass,
  displayHint,
  supportsOnLoad,
  openModeLabel,
  formatOpenHint,
};

globalThis.SnLinksBehaviors = SnLinksBehaviors;
})();
