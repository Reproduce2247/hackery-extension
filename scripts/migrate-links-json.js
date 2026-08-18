/**
 * One-off migration: rewrite data/links.json to canonical link schema (v3).
 * Run: node scripts/migrate-links-json.js
 */
const fs = require("fs");
const path = require("path");

const LINKS_PATH = path.join(__dirname, "..", "data", "links.json");

function normalizeOpenValue(value) {
  if (!value) return undefined;
  if (value === "foreground") return "tab";
  if (value === "fetch") return "download";
  return value;
}

function getParamsObject(node) {
  if (node.params) return node.params;
  if (node.parameters) return { ...node.parameters };
  if (node.parameter && !Array.isArray(node.parameter)) {
    const { name, ...rest } = node.parameter;
    return { [name || "value"]: rest };
  }
  return null;
}

function canonicalizeNavParamSpec(spec) {
  if (!spec || typeof spec !== "object") return {};
  const out = {};
  const fromUrl = spec.fromUrl || spec.url;
  const fromSelector = spec.fromSelector || spec.selector;
  if (fromUrl && fromSelector) {
    throw new Error("navParam cannot have both fromUrl and fromSelector.");
  }
  if (fromUrl) out.fromUrl = fromUrl;
  if (fromSelector) {
    out.fromSelector = fromSelector;
    if (spec.stringSource) out.stringSource = spec.stringSource;
    if (spec.attribute) out.attribute = spec.attribute;
  }
  if (Object.prototype.hasOwnProperty.call(spec, "placeholder")) {
    out.placeholder = spec.placeholder;
  }
  if (Object.prototype.hasOwnProperty.call(spec, "default")) {
    out.default = spec.default;
  }
  if (spec.optional) out.optional = true;
  if (Array.isArray(spec.choices) && spec.choices.length) out.choices = spec.choices;
  if (spec.label) out.label = spec.label;
  return out;
}

function normalizeNavParamsMap(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const out = {};
  for (const [name, spec] of Object.entries(raw)) {
    out[name] = canonicalizeNavParamSpec(spec);
  }
  return Object.keys(out).length ? out : undefined;
}

function collectParamNames(node, params) {
  const names = new Set();
  if (params) Object.keys(params).forEach((n) => names.add(n));
  return [...names];
}

function rewriteScriptletPlaceholders(code, paramNames) {
  let result = code;
  for (const name of paramNames) {
    result = result.split(`{${name}}`).join(name);
    result = result.replace(
      new RegExp(`(?<!\\\\)\\$${name}(?![a-zA-Z0-9_])`, "g"),
      name
    );
  }
  return result;
}

function normalizeLeaf(node) {
  const out = {};
  if (node.id) out.id = node.id;
  if (node.displayName) out.name = node.displayName;
  else if (node.name) out.name = node.name;
  if (typeof node.tooltip === "string" && node.tooltip.trim()) {
    out.tooltip = node.tooltip.trim();
  }
  if (Array.isArray(node.searchTags) && node.searchTags.length) {
    out.searchTags = node.searchTags;
  }
  if (Object.prototype.hasOwnProperty.call(node, "hostPattern")) {
    out.match = node.hostPattern;
  } else if (Object.prototype.hasOwnProperty.call(node, "match")) {
    out.match = node.match;
  }

  const open = normalizeOpenValue(node.open ?? node.nav);
  if (open) out.open = open;

  if (node.url) out.url = node.url;
  else if (node.path) out.url = node.path;

  if (node.code) out.code = node.code;

  const legacyParams = getParamsObject(node);
  let navParams = normalizeNavParamsMap(node.navParams);
  if (!navParams) navParams = normalizeNavParamsMap(node.extract);

  const isUrlAction = Boolean(out.url);
  const isScriptAction = Boolean(out.code);

  if (isUrlAction && !isScriptAction) {
    if (legacyParams) {
      navParams = navParams || {};
      for (const [name, config] of Object.entries(legacyParams)) {
        navParams[name] = canonicalizeNavParamSpec({
          ...(navParams[name] || {}),
          ...config,
        });
      }
    }
    if (navParams) out.navParams = navParams;
  } else if (legacyParams) {
    out.params = legacyParams;
  }

  if (out.code) {
    const names = collectParamNames(node, out.params);
    out.code = rewriteScriptletPlaceholders(out.code, names);
  }

  return out;
}

function normalizeTree(node) {
  if (node.children) {
    const folder = {
      name: node.name,
      children: node.children.map(normalizeTree),
    };
    if (Object.prototype.hasOwnProperty.call(node, "hostPattern")) {
      folder.match = node.hostPattern;
    } else if (Object.prototype.hasOwnProperty.call(node, "match")) {
      folder.match = node.match;
    }
    return folder;
  }
  return normalizeLeaf(node);
}

function normalizeCatalog(raw) {
  const out = {};
  for (const [sectionName, section] of Object.entries(raw)) {
    const normalized = {
      children: (section.children || []).map(normalizeTree),
    };
    if (Object.prototype.hasOwnProperty.call(section, "hostPattern")) {
      normalized.match = section.hostPattern;
    } else if (Object.prototype.hasOwnProperty.call(section, "match")) {
      normalized.match = section.match;
    }
    out[sectionName] = normalized;
  }
  return out;
}

const raw = JSON.parse(fs.readFileSync(LINKS_PATH, "utf8"));
const migrated = normalizeCatalog(raw);
fs.writeFileSync(LINKS_PATH, `${JSON.stringify(migrated, null, 2)}\n`, "utf8");
console.log("Migrated", LINKS_PATH);
