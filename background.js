const INJECT_ON_LOAD_KEY = "injectOnLoad";
const PARAM_VALUES_KEY = "linkParamValues";
const CUSTOM_SCRIPTS_KEY = "customScripts";
const INJECT_SCRIPT_ID = "sn-links-on-load";
const PARAM_TOKEN_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

let linksCache = null;
/** @type {{ hostPattern: string | null, code: string }[]} */
let injectEntries = [];

function extractNavigationPath(code) {
  const match = code.match(/window\.location\.href\s*=\s*(['"])(.*?)\1/);
  return match ? match[2] : null;
}

function getLinkTemplate(node) {
  if (node.type === "scriptlet") return node.code || "";
  return "";
}

function linkStorageKey(node) {
  if (node.id) return node.id;
  const sectionPrefix = node.sectionName ? `${node.sectionName}:` : "";
  return `${sectionPrefix}${node.type}:${node.name}:${getLinkTemplate(node)}`;
}

function getParameterConfig(node, paramName) {
  if (node.parameters?.[paramName]) return node.parameters[paramName];
  const single = node.parameter;
  if (single && !Array.isArray(single)) {
    const singleName = single.name || "value";
    if (paramName === singleName) return single;
  }
  return null;
}

function getParameterDefs(node) {
  const template = getLinkTemplate(node);
  const found = [...template.matchAll(PARAM_TOKEN_RE)].map((match) => match[1]);
  const scriptParams = [
    ...template.matchAll(/(^|[^\\])\$([a-zA-Z_][a-zA-Z0-9_]*)/g),
  ].map((match) => match[2]);
  found.push(...scriptParams);
  const unique = [...new Set(found)];
  if (node.parameter && !Array.isArray(node.parameter)) {
    const name = node.parameter.name || "value";
    if (!unique.includes(name)) unique.unshift(name);
  }
  return unique.map((paramName) => {
    const config = getParameterConfig(node, paramName) || {};
    return { name: paramName, default: config.default ?? "" };
  });
}

function applyParameters(template, values) {
  let result = template;
  for (const [name, value] of Object.entries(values)) {
    result = result.split(`{${name}}`).join(value ?? "");
    result = result.replace(
      new RegExp(`(?<!\\\\)\\$${name}(?![a-zA-Z0-9_])`, "g"),
      value ?? ""
    );
  }
  return result;
}

function resolveParamValues(parameterDefs, rawValues) {
  const values = {};
  for (const def of parameterDefs) {
    const raw = rawValues[def.name];
    values[def.name] = raw !== "" && raw !== undefined ? raw : def.default;
  }
  return values;
}

function matchesHostPattern(urlString, pattern) {
  if (!pattern) return true;
  try {
    return new RegExp(pattern, "i").test(new URL(urlString).hostname);
  } catch {
    return false;
  }
}

function resolveHostPattern(node, inherited) {
  if (Object.prototype.hasOwnProperty.call(node, "hostPattern")) {
    return node.hostPattern || null;
  }
  return inherited ?? null;
}

function collectScriptlets(nodes, inheritedHostPattern, sectionName, out) {
  for (const node of nodes) {
    const hostPattern = resolveHostPattern(node, inheritedHostPattern);
    if (node.children) {
      collectScriptlets(node.children, hostPattern, sectionName, out);
      continue;
    }
    if (node.type !== "scriptlet") continue;
    out.push({
      linkKey: linkStorageKey({ ...node, sectionName }),
      node: { ...node, hostPattern, sectionName },
    });
  }
}

async function getLinkSections() {
  if (!linksCache) {
    const response = await fetch(browser.runtime.getURL("data/links.json"));
    linksCache = await response.json();
  }
  return linksCache;
}

function buildMatches(entries) {
  if (entries.some((entry) => !entry.hostPattern)) {
    return ["http://*/*", "https://*/*"];
  }

  const matches = new Set();
  for (const entry of entries) {
    if (/service-now\\\.com/.test(entry.hostPattern)) {
      matches.add("*://*.service-now.com/*");
    }
  }

  return matches.size ? [...matches] : ["http://*/*", "https://*/*"];
}

function codesForUrl(url) {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return [];
  }

  return injectEntries
    .filter((entry) => matchesHostPattern(url, entry.hostPattern))
    .map((entry) => entry.code);
}

async function rebuildInjectCache() {
  const stored = await browser.storage.local.get([
    INJECT_ON_LOAD_KEY,
    PARAM_VALUES_KEY,
    CUSTOM_SCRIPTS_KEY,
  ]);
  const injectOnLoad = stored[INJECT_ON_LOAD_KEY] || {};
  const paramValues = stored[PARAM_VALUES_KEY] || {};
  const customScripts = stored[CUSTOM_SCRIPTS_KEY] || [];
  const sections = await getLinkSections();
  const scriptlets = [];

  for (const [name, section] of Object.entries(sections)) {
    collectScriptlets(section.children || [], section.hostPattern ?? null, name, scriptlets);
  }

  for (const script of customScripts) {
    scriptlets.push({
      linkKey: script.id,
      node: {
        id: script.id,
        name: script.name,
        type: "scriptlet",
        code: script.code,
        hostPattern: null,
      },
    });
  }

  injectEntries = [];
  for (const { linkKey, node } of scriptlets) {
    if (!injectOnLoad[linkKey]) continue;
    if (extractNavigationPath(node.code)) continue;

    const parameterDefs = getParameterDefs(node);
    const rawValues = paramValues[linkKey] || {};
    const values = resolveParamValues(parameterDefs, rawValues);
    injectEntries.push({
      hostPattern: node.hostPattern ?? null,
      code: applyParameters(node.code, values),
    });
  }
}

async function syncInjectRegistration() {
  try {
    await browser.scripting.unregisterContentScripts({ ids: [INJECT_SCRIPT_ID] });
  } catch {
    // not registered yet
  }

  if (injectEntries.length === 0) {
    return;
  }

  await browser.scripting.registerContentScripts([
    {
      id: INJECT_SCRIPT_ID,
      matches: buildMatches(injectEntries),
      runAt: "document_start",
      allFrames: true,
      js: [{ file: "inject/on-load.js" }],
    },
  ]);
}

async function refreshInjectState() {
  await rebuildInjectCache();
  await syncInjectRegistration();
}

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_INJECT_CODES") {
    sendResponse({ codes: codesForUrl(message.url || "") });
    return false;
  }
  if (message?.type === "REFRESH_INJECT") {
    refreshInjectState().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (
    changes[INJECT_ON_LOAD_KEY] ||
    changes[PARAM_VALUES_KEY] ||
    changes[CUSTOM_SCRIPTS_KEY]
  ) {
    refreshInjectState();
  }
});

browser.runtime.onInstalled.addListener(() => {
  linksCache = null;
  refreshInjectState();
});

browser.runtime.onStartup.addListener(() => {
  refreshInjectState();
});

refreshInjectState();
