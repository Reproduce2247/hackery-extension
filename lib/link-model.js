(function () {
function extractNavigationPath(code) {
  const match = code.match(/window\.location\.href\s*=\s*(['"])(.*?)\1/);
  return match ? match[2] : null;
}

function getLinkTemplate(node) {
  if (node.type === "navigate" || node.type === "derived-url") {
    return node.url || node.path || "";
  }
  if (node.type === "scriptlet") {
    return node.code || "";
  }
  return "";
}

function linkStorageKey(node) {
  if (node.id) {
    return node.id;
  }
  const sectionPrefix = node.sectionName ? `${node.sectionName}:` : "";
  return `${sectionPrefix}${node.type}:${node.name}:${getLinkTemplate(node)}`;
}

function getParameterConfig(node, paramName) {
  if (node.parameters?.[paramName]) {
    return node.parameters[paramName];
  }

  const single = node.parameter;
  if (single && !Array.isArray(single)) {
    const singleName = single.name || "value";
    if (paramName === singleName) {
      return single;
    }
  }

  return null;
}

function getParameterDefNames(node) {
  const names = [];

  if (node.parameters && typeof node.parameters === "object") {
    names.push(...Object.keys(node.parameters));
  }

  if (node.parameter && !Array.isArray(node.parameter)) {
    const name = node.parameter.name || "value";
    if (!names.includes(name)) {
      names.unshift(name);
    }
  }

  return names;
}

function getParameterDefs(node) {
  return getParameterDefNames(node).map((paramName) => {
    const config = getParameterConfig(node, paramName) || {};
    return {
      name: paramName,
      label: config.label || paramName,
      default: config.default ?? "",
      optional: Boolean(config.optional),
    };
  });
}

function applyTemplate(template, values, { scriptlet = false, encode = false } = {}) {
  let result = template;
  if (encode) {
    result = result.replace(
      /\{encode:([a-zA-Z_][a-zA-Z0-9_]*)\}/g,
      (_, name) => encodeURIComponent(values[name] ?? "")
    );
  }
  for (const [name, value] of Object.entries(values)) {
    result = result.split(`{${name}}`).join(value ?? "");
    if (scriptlet) {
      result = result.replace(
        new RegExp(`(?<!\\\\)\\$${name}(?![a-zA-Z0-9_])`, "g"),
        value ?? ""
      );
    }
  }
  return result;
}

function applyParameters(template, values, options = {}) {
  return applyTemplate(template, values, { scriptlet: options.scriptlet });
}

function resolveParamValues(parameterDefs, rawValues) {
  const values = {};
  for (const def of parameterDefs) {
    const raw = rawValues[def.name];
    values[def.name] = raw !== "" && raw !== undefined ? raw : def.default;
  }
  return values;
}

function resolveHostPattern(node, inherited) {
  if (Object.prototype.hasOwnProperty.call(node, "hostPattern")) {
    return node.hostPattern || null;
  }
  return inherited ?? null;
}

function createHostPatternMatcher(regexCache) {
  const cache = regexCache || new Map();
  return function matchesHostPattern(urlString, pattern) {
    if (!pattern) {
      return true;
    }
    try {
      const url = new URL(urlString);
      if (!cache.has(pattern)) {
        cache.set(pattern, new RegExp(pattern, "i"));
      }
      const re = cache.get(pattern);
      return re.test(url.hostname) || re.test(url.href);
    } catch {
      return false;
    }
  };
}

const matchesHostPattern = createHostPatternMatcher();

function walkLinkTree(
  nodes,
  inheritedHostPattern = null,
  sectionName = null,
  visitor
) {
  for (const node of nodes) {
    const hostPattern = resolveHostPattern(node, inheritedHostPattern);
    if (node.children) {
      walkLinkTree(node.children, hostPattern, sectionName, visitor);
      continue;
    }
    visitor({ ...node, hostPattern, sectionName });
  }
}

function flattenLinkNodes(nodes, inheritedHostPattern = null, sectionName = null) {
  const results = [];
  walkLinkTree(nodes, inheritedHostPattern, sectionName, (node) => {
    results.push(node);
  });
  return results;
}

function collectScriptlets(nodes, inheritedHostPattern, sectionName, out) {
  walkLinkTree(nodes, inheritedHostPattern, sectionName, (node) => {
    if (node.type !== "scriptlet" || node.nav) {
      return;
    }
    out.push({
      linkKey: linkStorageKey(node),
      node,
    });
  });
}

function parseLinkSections(raw) {
  return Object.entries(raw).map(([name, section]) => ({
    name,
    hostPattern: section?.hostPattern ?? null,
    children: section?.children || [],
  }));
}

function normalizeScriptInput(raw) {
  let code = raw.trim();
  if (!code) {
    return "";
  }

  if (code.toLowerCase().startsWith("javascript:")) {
    code = code.slice("javascript:".length);
  }

  try {
    code = decodeURIComponent(code);
  } catch {
    // keep literal pasted text when it is not URI-encoded
  }

  if (code.startsWith("void(") && code.endsWith(")")) {
    code = code.slice(5, -1);
  }

  return code.trim();
}

function resolveNode(node, paramValues) {
  const parameterDefs = getParameterDefs(node);
  if (parameterDefs.length === 0) {
    return node;
  }

  const values = {};
  for (const def of parameterDefs) {
    const value = paramValues[def.name];
    if (value !== "" && value !== undefined) {
      values[def.name] = value;
    } else if (!def.optional) {
      values[def.name] = value ?? def.default ?? "";
    }
  }
  if (Object.keys(values).length === 0) {
    return node;
  }

  const apply = (template) =>
    applyParameters(template, values, { scriptlet: node.type === "scriptlet" });

  if (node.type === "navigate") {
    return { ...node, path: apply(node.path || "") };
  }
  if (node.type === "derived-url") {
    const result = { ...node };
    if (node.path) {
      result.path = apply(node.path);
    }
    if (node.url) {
      result.url = apply(node.url);
    }
    return result;
  }
  if (node.type === "scriptlet") {
    return { ...node, code: apply(node.code || "") };
  }
  return node;
}

function nodeHasOnLoad(node) {
  return (
    node.type === "scriptlet" &&
    !node.nav &&
    !extractNavigationPath(node.code || "")
  );
}

function defaultScriptName(code, scripts) {
  const navPath = extractNavigationPath(code);
  if (navPath) {
    const leaf = navPath.split(/[/?#]/)[0].replace(/\.do$/, "") || "page";
    return `Go to ${leaf}`;
  }

  return `Custom script ${scripts.length + 1}`;
}

const SnLinksLinkModel = {
  PARAM_VALUES_KEY: globalThis.SnLinksStorageKeys.PARAM_VALUES_KEY,
  INJECT_ON_LOAD_KEY: globalThis.SnLinksStorageKeys.INJECT_ON_LOAD_KEY,
  CUSTOM_SCRIPTS_KEY: globalThis.SnLinksStorageKeys.CUSTOM_SCRIPTS_KEY,
  extractNavigationPath,
  getLinkTemplate,
  linkStorageKey,
  getParameterConfig,
  getParameterDefNames,
  getParameterDefs,
  applyTemplate,
  applyParameters,
  resolveParamValues,
  resolveHostPattern,
  matchesHostPattern,
  createHostPatternMatcher,
  walkLinkTree,
  flattenLinkNodes,
  collectScriptlets,
  parseLinkSections,
  normalizeScriptInput,
  resolveNode,
  nodeHasOnLoad,
  defaultScriptName,
};

globalThis.SnLinksLinkModel = SnLinksLinkModel;
})();
