(function () {
const LINKS_SCHEMA_VERSION = 3;

const RESERVED_PARAM_NAMES = new Set(["arguments"]);

function normalizeOpenValue(value) {
  if (!value) {
    return undefined;
  }
  if (value === "foreground") {
    return "tab";
  }
  if (value === "fetch") {
    return "download";
  }
  return value;
}

function getLinkTemplate(node) {
  if (node.url) {
    return node.url;
  }
  if (node.code) {
    return node.code;
  }
  return "";
}

function linkStorageKey(node) {
  if (node.id) {
    return node.id;
  }
  const sectionPrefix = node.sectionName ? `${node.sectionName}:` : "";
  const behaviorId =
    globalThis.SnLinksBehaviors?.matchBehavior?.(node)?.id ?? "action";
  return `${sectionPrefix}${behaviorId}:${node.name}:${getLinkTemplate(node)}`;
}

/**
 * Script/function bindings only (`params` / legacy parameter fields).
 */
function getParamsObject(node) {
  if (node.params && typeof node.params === "object") {
    return node.params;
  }
  if (node.parameters && typeof node.parameters === "object") {
    return node.parameters;
  }
  const single = node.parameter;
  if (single && !Array.isArray(single)) {
    const name = single.name || "value";
    const { name: _drop, ...rest } = single;
    return { [name]: rest };
  }
  return null;
}

function getParameterConfig(node, paramName) {
  const params = getParamsObject(node);
  return params?.[paramName] ?? null;
}

/**
 * URL/URI substitution values (`navParams`, or legacy `extract` before normalize).
 */
function getNavParamsObject(node) {
  if (node.navParams && typeof node.navParams === "object" && !Array.isArray(node.navParams)) {
    return node.navParams;
  }
  if (node.extract && typeof node.extract === "object" && !Array.isArray(node.extract)) {
    return node.extract;
  }
  return null;
}

function getNavParamConfig(node, paramName) {
  const navParams = getNavParamsObject(node);
  return navParams?.[paramName] ?? null;
}

function normalizeStringSource(source) {
  const key = String(source || "textContent")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase();
  if (key === "innerhtml" || key === "inner_html") {
    return "innerHTML";
  }
  if (key === "textcontent" || key === "text_content" || key === "text") {
    return "textContent";
  }
  if (key === "id") {
    return "id";
  }
  if (key === "attribute" || key === "otherattribute" || key === "other_attribute") {
    return "attribute";
  }
  throw new Error(`Unknown navParam stringSource: ${source}`);
}

/**
 * Normalize one navParam into a runtime derivation entry (or null if manual-only).
 */
function normalizeNavParamDerivation(paramName, spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error(`Invalid navParam spec for ${paramName}.`);
  }

  const fromUrl = spec.fromUrl || spec.url || null;
  const fromSelector = spec.fromSelector || spec.selector || null;
  if (fromUrl && fromSelector) {
    throw new Error(
      `navParam "${paramName}" cannot have both fromUrl and fromSelector.`
    );
  }

  if (fromSelector) {
    const stringSource = normalizeStringSource(spec.stringSource);
    if (stringSource === "attribute" && !spec.attribute) {
      throw new Error(
        `navParam "${paramName}" requires attribute when stringSource is attribute.`
      );
    }
    return {
      paramName,
      kind: "dom",
      selector: fromSelector,
      stringSource,
      attribute: spec.attribute || null,
    };
  }

  if (fromUrl) {
    return { paramName, kind: "url", pattern: fromUrl };
  }

  return null;
}

function normalizeNavParamDerivations(navParams) {
  if (!navParams) {
    return [];
  }
  if (typeof navParams !== "object" || Array.isArray(navParams)) {
    throw new Error("navParams must be an object mapping names to specs.");
  }
  return Object.entries(navParams)
    .map(([paramName, spec]) => normalizeNavParamDerivation(paramName, spec))
    .filter(Boolean);
}

/** @deprecated use normalizeNavParamDerivation */
function normalizeExtractEntry(paramName, spec) {
  const entry = normalizeNavParamDerivation(paramName, spec);
  if (!entry) {
    throw new Error(
      `Extract for ${paramName} requires fromUrl/url or fromSelector/selector.`
    );
  }
  return entry;
}

/** @deprecated use normalizeNavParamDerivations */
function normalizeExtractEntries(extract) {
  if (!extract) {
    return [];
  }
  return normalizeNavParamDerivations(extract);
}

function getExtractParamNames(node) {
  const navParams = getNavParamsObject(node);
  if (!navParams) {
    return [];
  }
  return Object.keys(navParams);
}

function defFromConfig(paramName, config = {}) {
  return {
    name: paramName,
    label: config.label || paramName,
    placeholder: Object.prototype.hasOwnProperty.call(config, "placeholder")
      ? config.placeholder
      : undefined,
    showInput: Object.prototype.hasOwnProperty.call(config, "placeholder"),
    default: config.default ?? "",
    optional: Boolean(config.optional),
    choices: Array.isArray(config.choices) ? config.choices : null,
    source: config.source || null,
    fromUrl: config.fromUrl || config.url || null,
    fromSelector: config.fromSelector || config.selector || null,
  };
}

function getParameterDefNames(node) {
  const params = getParamsObject(node);
  return params ? Object.keys(params) : [];
}

/**
 * Script `params` definitions (not URL navParams).
 */
function getParameterDefs(node) {
  return getParameterDefNames(node).map((paramName) => {
    const config = getParameterConfig(node, paramName) || {};
    return defFromConfig(paramName, config);
  });
}

function getEditableParameterDefs(node) {
  return getParameterDefs(node).filter((def) => def.source !== "contextElement");
}

function getNavParamDefNames(node) {
  const navParams = getNavParamsObject(node);
  return navParams ? Object.keys(navParams) : [];
}

function getNavParamDefs(node) {
  return getNavParamDefNames(node).map((paramName) => {
    const config = getNavParamConfig(node, paramName) || {};
    return defFromConfig(paramName, config);
  });
}

/**
 * navParams opted into the popup UI via an explicit `placeholder` key.
 */
function getEditableNavParamDefs(node) {
  return getNavParamDefs(node).filter((def) => def.showInput);
}

/**
 * Runtime value defs for the node's primary value channel.
 * URL actions use navParams; script actions use params.
 */
function getRuntimeValueDefs(node) {
  if (node.url) {
    return getNavParamDefs(node);
  }
  return getParameterDefs(node);
}

function getEditableValueDefs(node) {
  if (node.url) {
    return getEditableNavParamDefs(node);
  }
  return getEditableParameterDefs(node);
}

function applyTemplate(template, values, { encode = false } = {}) {
  let result = template;
  if (encode) {
    result = result.replace(
      /\{encode:([a-zA-Z_][a-zA-Z0-9_]*)\}/g,
      (_, name) => encodeURIComponent(values[name] ?? "")
    );
  }
  for (const [name, value] of Object.entries(values)) {
    result = result.split(`{${name}}`).join(value ?? "");
  }
  return result;
}

function applyParameters(template, values) {
  return applyTemplate(template, values, { encode: false });
}

/**
 * Resolve script params: non-empty manual, else default.
 */
function resolveParamValues(parameterDefs, rawValues) {
  const values = {};
  for (const def of parameterDefs) {
    const raw = rawValues[def.name];
    values[def.name] = raw !== "" && raw !== undefined ? raw : def.default;
  }
  return values;
}

/**
 * Seed navParam values from manual input only.
 * Blank input is omitted so derivation can run before defaults.
 */
function seedNavParamValues(navParamDefs, rawValues) {
  const values = {};
  for (const def of navParamDefs) {
    const raw = rawValues[def.name];
    if (raw !== "" && raw !== undefined) {
      values[def.name] = raw;
    }
  }
  return values;
}

function resolveMatch(node, inherited) {
  if (Object.prototype.hasOwnProperty.call(node, "match")) {
    return node.match || null;
  }
  if (Object.prototype.hasOwnProperty.call(node, "hostPattern")) {
    return node.hostPattern || null;
  }
  return inherited ?? null;
}

/** @deprecated use resolveMatch */
function resolveHostPattern(node, inherited) {
  return resolveMatch(node, inherited);
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
  inheritedMatch = null,
  sectionName = null,
  visitor
) {
  for (const node of nodes) {
    const match = resolveMatch(node, inheritedMatch);
    if (node.children) {
      walkLinkTree(node.children, match, sectionName, visitor);
      continue;
    }
    visitor({ ...node, match, sectionName });
  }
}

function flattenLinkNodes(nodes, inheritedMatch = null, sectionName = null) {
  const results = [];
  walkLinkTree(nodes, inheritedMatch, sectionName, (node) => {
    results.push(node);
  });
  return results;
}

function collectScriptlets(nodes, inheritedMatch, sectionName, out) {
  walkLinkTree(nodes, inheritedMatch, sectionName, (node) => {
    if (!globalThis.SnLinksBehaviors?.supportsOnLoad?.(node)) {
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
    match: section?.match ?? section?.hostPattern ?? null,
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

/**
 * Preview helper: substitute known navParam values into the URL template.
 * Does not run page derivation.
 */
function resolveNode(node, paramValues) {
  if (!node.url) {
    return node;
  }

  const defs = getNavParamDefs(node);
  if (defs.length === 0) {
    return node;
  }

  const values = {};
  for (const def of defs) {
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

  return { ...node, url: applyParameters(node.url, values) };
}

function nodeHasOnLoad(node) {
  return globalThis.SnLinksBehaviors?.supportsOnLoad?.(node) ?? false;
}

function defaultScriptName(_code, scripts) {
  return `Custom script ${scripts.length + 1}`;
}

function collectParamNamesForRewrite(node) {
  const names = new Set(getParameterDefNames(node));
  return [...names].filter((name) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name));
}

function rewriteScriptletPlaceholders(code, paramNames) {
  let result = code;
  for (const name of paramNames) {
    if (RESERVED_PARAM_NAMES.has(name)) {
      continue;
    }
    result = result.split(`{${name}}`).join(name);
    result = result.replace(
      new RegExp(`(?<!\\\\)\\$${name}(?![a-zA-Z0-9_])`, "g"),
      name
    );
  }
  return result;
}

function normalizeParamsFromLegacy(node) {
  const params = getParamsObject(node);
  if (!params) {
    return undefined;
  }
  const out = {};
  for (const [name, config] of Object.entries(params)) {
    if (!config || typeof config !== "object") {
      out[name] = {};
      continue;
    }
    const { name: _drop, ...rest } = config;
    out[name] = rest;
  }
  return Object.keys(out).length ? out : undefined;
}

function canonicalizeNavParamSpec(spec) {
  if (!spec || typeof spec !== "object") {
    return {};
  }

  const out = {};
  const fromUrl = spec.fromUrl || spec.url;
  const fromSelector = spec.fromSelector || spec.selector;
  if (fromUrl && fromSelector) {
    throw new Error("navParam cannot have both fromUrl and fromSelector.");
  }
  if (fromUrl) {
    out.fromUrl = fromUrl;
  }
  if (fromSelector) {
    out.fromSelector = fromSelector;
    if (spec.stringSource) {
      out.stringSource = normalizeStringSource(spec.stringSource);
    }
    if (spec.attribute) {
      out.attribute = spec.attribute;
    }
  }

  if (Object.prototype.hasOwnProperty.call(spec, "placeholder")) {
    out.placeholder = spec.placeholder;
  }
  if (Object.prototype.hasOwnProperty.call(spec, "default")) {
    out.default = spec.default;
  }
  if (spec.optional) {
    out.optional = true;
  }
  if (Array.isArray(spec.choices) && spec.choices.length) {
    out.choices = spec.choices;
  }
  if (spec.label) {
    out.label = spec.label;
  }
  if (spec.source) {
    out.source = spec.source;
  }

  return out;
}

function mergeNavParamSpecs(base, extra) {
  return canonicalizeNavParamSpec({ ...(base || {}), ...(extra || {}) });
}

/**
 * Build canonical navParams from navParams / extract, renaming legacy keys.
 */
function normalizeNavParamsMap(rawMap) {
  if (!rawMap || typeof rawMap !== "object" || Array.isArray(rawMap)) {
    return undefined;
  }
  const out = {};
  for (const [name, spec] of Object.entries(rawMap)) {
    out[name] = canonicalizeNavParamSpec(spec);
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeLeafNode(node) {
  const out = {};

  if (node.id) {
    out.id = node.id;
  }
  if (node.name) {
    out.name = node.name;
  }
  if (node.displayName) {
    out.displayName = node.displayName;
  }
  if (Array.isArray(node.searchTags) && node.searchTags.length) {
    out.searchTags = node.searchTags;
  }

  if (Object.prototype.hasOwnProperty.call(node, "match")) {
    out.match = node.match;
  } else if (Object.prototype.hasOwnProperty.call(node, "hostPattern")) {
    out.match = node.hostPattern;
  }

  const open = normalizeOpenValue(node.open ?? node.nav);
  if (open) {
    out.open = open;
  }

  if (node.url) {
    out.url = node.url;
  } else if (node.path) {
    out.url = node.path;
  }

  if (node.code) {
    out.code = node.code;
  }

  const legacyParams = normalizeParamsFromLegacy(node);
  let navParams = normalizeNavParamsMap(node.navParams);
  if (!navParams) {
    navParams = normalizeNavParamsMap(node.extract);
  }

  const isUrlAction = Boolean(out.url);
  const isScriptAction = Boolean(out.code);

  // Mutual exclusion: URL actions own navParams; script actions own params.
  if (isUrlAction && !isScriptAction) {
    if (legacyParams) {
      navParams = navParams || {};
      for (const [name, config] of Object.entries(legacyParams)) {
        navParams[name] = mergeNavParamSpecs(navParams[name], config);
      }
    }
    if (navParams && Object.keys(navParams).length) {
      out.navParams = navParams;
    }
  } else {
    if (legacyParams) {
      out.params = legacyParams;
    }
    // Ignore navParams/extract on pure script actions.
  }

  if (out.code) {
    const paramNames = collectParamNamesForRewrite({ ...node, params: out.params });
    out.code = rewriteScriptletPlaceholders(out.code, paramNames);
  }

  return out;
}

function normalizeTreeNode(node) {
  if (node.children) {
    const folder = { name: node.name, children: node.children.map(normalizeTreeNode) };
    if (Object.prototype.hasOwnProperty.call(node, "match")) {
      folder.match = node.match;
    } else if (Object.prototype.hasOwnProperty.call(node, "hostPattern")) {
      folder.match = node.hostPattern;
    }
    return folder;
  }
  return normalizeLeafNode(node);
}

function normalizeCatalog(raw) {
  if (!raw || typeof raw !== "object") {
    return raw;
  }
  const out = {};
  for (const [sectionName, section] of Object.entries(raw)) {
    if (!section || typeof section !== "object") {
      continue;
    }
    const normalized = {
      children: (section.children || []).map(normalizeTreeNode),
    };
    if (Object.prototype.hasOwnProperty.call(section, "match")) {
      normalized.match = section.match;
    } else if (Object.prototype.hasOwnProperty.call(section, "hostPattern")) {
      normalized.match = section.hostPattern;
    }
    out[sectionName] = normalized;
  }
  return out;
}

function navParamNeedsCanonicalization(spec) {
  if (!spec || typeof spec !== "object") {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(spec, "url") ||
    Object.prototype.hasOwnProperty.call(spec, "selector")
  );
}

function isLegacyNode(node) {
  if (
    node.type ||
    node.path ||
    node.nav ||
    node.hostPattern ||
    node.parameter ||
    node.parameters ||
    node.extract
  ) {
    return true;
  }
  if (node.url && !node.code && node.params) {
    // URL-only params belong in navParams.
    return true;
  }
  if (node.navParams && typeof node.navParams === "object") {
    return Object.values(node.navParams).some(navParamNeedsCanonicalization);
  }
  return false;
}

function catalogNeedsNormalization(raw) {
  for (const section of Object.values(raw || {})) {
    if (section?.hostPattern && !Object.prototype.hasOwnProperty.call(section, "match")) {
      return true;
    }
    const stack = [...(section?.children || [])];
    while (stack.length) {
      const node = stack.pop();
      if (node.children) {
        stack.push(...node.children);
        if (node.hostPattern && !Object.prototype.hasOwnProperty.call(node, "match")) {
          return true;
        }
        continue;
      }
      if (isLegacyNode(node)) {
        return true;
      }
    }
  }
  return false;
}

const SnLinksLinkModel = {
  LINKS_SCHEMA_VERSION,
  PARAM_VALUES_KEY: globalThis.SnLinksStorageKeys.PARAM_VALUES_KEY,
  INJECT_ON_LOAD_KEY: globalThis.SnLinksStorageKeys.INJECT_ON_LOAD_KEY,
  CUSTOM_SCRIPTS_KEY: globalThis.SnLinksStorageKeys.CUSTOM_SCRIPTS_KEY,
  getExtractParamNames,
  getNavParamsObject,
  getNavParamConfig,
  getNavParamDefs,
  getEditableNavParamDefs,
  getRuntimeValueDefs,
  getEditableValueDefs,
  normalizeStringSource,
  normalizeNavParamDerivation,
  normalizeNavParamDerivations,
  normalizeExtractEntry,
  normalizeExtractEntries,
  getLinkTemplate,
  linkStorageKey,
  getParameterConfig,
  getParamsObject,
  getParameterDefNames,
  getParameterDefs,
  getEditableParameterDefs,
  applyTemplate,
  applyParameters,
  resolveParamValues,
  seedNavParamValues,
  resolveMatch,
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
  normalizeCatalog,
  catalogNeedsNormalization,
  rewriteScriptletPlaceholders,
  normalizeLeafNode,
  normalizeTreeNode,
};

globalThis.SnLinksLinkModel = SnLinksLinkModel;
})();
