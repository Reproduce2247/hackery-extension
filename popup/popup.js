const NAV_TARGET_PREFIX = /^now\/nav\/ui\/classic\/params\/target\//;
const LAST_ORIGINS_KEY = "lastOrigins";
const hostPatternCache = new Map();

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

function extractNavigationPath(code) {
  const match = code.match(/window\.location\.href\s*=\s*(['"])(.*?)\1/);
  return match ? match[2] : null;
}

const CUSTOM_SCRIPTS_KEY = "customScripts";
const PARAM_VALUES_KEY = "linkParamValues";
const SECTION_TAB_KEY = "activeSectionTab";
const ADD_SCRIPT_EXPANDED_KEY = "addScriptExpanded";
const INJECT_ON_LOAD_KEY = "injectOnLoad";
const PARAM_TOKEN_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

const sectionTabsEl = document.getElementById("section-tabs");
const linksEl = document.getElementById("links");
const instanceStatusEl = document.getElementById("instance-status");
const messageEl = document.getElementById("message");
const scriptNameInput = document.getElementById("script-name");
const scriptCodeInput = document.getElementById("script-code");
const addScriptBtn = document.getElementById("add-script-btn");
const addScriptSection = document.querySelector(".add-script");
const addScriptToggle = document.getElementById("add-script-toggle");
const addScriptPanel = document.getElementById("add-script-panel");

let linkSections = null;
let activeSectionName = null;

function parseLinkSections(raw) {
  return Object.entries(raw).map(([name, section]) => ({
    name,
    hostPattern: section?.hostPattern ?? null,
    children: section?.children || [],
  }));
}

function getActiveSection() {
  return linkSections?.find((section) => section.name === activeSectionName) || null;
}

function showMessage(text) {
  messageEl.textContent = text;
  messageEl.classList.remove("hidden");
}

function hideMessage() {
  messageEl.classList.add("hidden");
}

function resolveHostPattern(node, inherited) {
  if (Object.prototype.hasOwnProperty.call(node, "hostPattern")) {
    return node.hostPattern || null;
  }
  return inherited ?? null;
}

function getHostPatternRegex(pattern) {
  if (!hostPatternCache.has(pattern)) {
    hostPatternCache.set(pattern, new RegExp(pattern, "i"));
  }
  return hostPatternCache.get(pattern);
}

function matchesHostPattern(urlString, pattern) {
  if (!pattern) {
    return true;
  }
  try {
    return getHostPatternRegex(pattern).test(new URL(urlString).hostname);
  } catch {
    return false;
  }
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

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function rememberOrigin(hostPattern, origin) {
  const stored = await browser.storage.local.get(LAST_ORIGINS_KEY);
  const lastOrigins = stored[LAST_ORIGINS_KEY] || {};
  lastOrigins[hostPattern] = origin;
  await browser.storage.local.set({ [LAST_ORIGINS_KEY]: lastOrigins });
}

async function getRememberedOrigin(hostPattern) {
  const stored = await browser.storage.local.get(LAST_ORIGINS_KEY);
  return (stored[LAST_ORIGINS_KEY] || {})[hostPattern] || null;
}

async function findMatchingTab(hostPattern, preferredOrigin) {
  const tabs = await browser.tabs.query({ currentWindow: true });
  const matchingTabs = tabs.filter(
    (tab) => tab.url && matchesHostPattern(tab.url, hostPattern)
  );

  if (preferredOrigin) {
    const match = matchingTabs.find(
      (tab) => new URL(tab.url).origin === preferredOrigin
    );
    if (match) return match;
  }

  return matchingTabs[0] || null;
}

async function ensureMatchingTab(hostPattern, origin) {
  const existing = await findMatchingTab(hostPattern, origin);
  if (existing) {
    return existing;
  }

  if (!origin) {
    throw new Error(
      `Open a tab matching /${hostPattern}/ first, or visit one so the extension can remember it.`
    );
  }

  return browser.tabs.create({ url: `${origin}/`, active: false });
}

async function waitForTabLoad(tabId) {
  const tab = await browser.tabs.get(tabId);
  if (tab.status === "complete") {
    return tab;
  }

  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo, updatedTab) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        browser.tabs.onUpdated.removeListener(listener);
        resolve(updatedTab);
      }
    };
    browser.tabs.onUpdated.addListener(listener);
  });
}

async function getActiveTargetTab() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    throw new Error("No active tab.");
  }
  const origin = tab.url ? new URL(tab.url).origin : null;
  return { tab, origin };
}

async function getTargetTab(hostPattern) {
  if (!hostPattern) {
    return getActiveTargetTab();
  }

  const activeTab = await getActiveTab();
  if (activeTab?.url && matchesHostPattern(activeTab.url, hostPattern)) {
    const origin = new URL(activeTab.url).origin;
    await rememberOrigin(hostPattern, origin);
    return { tab: activeTab, origin };
  }

  const rememberedOrigin = await getRememberedOrigin(hostPattern);
  const tab = await ensureMatchingTab(hostPattern, rememberedOrigin);
  const loadedTab =
    tab.status === "complete" ? tab : await waitForTabLoad(tab.id);
  const origin = new URL(loadedTab.url).origin;
  await rememberOrigin(hostPattern, origin);
  return { tab: loadedTab, origin };
}

function displayLabel(node) {
  if (node.name === "App Log | ServiceNow") {
    if (node.type === "scriptlet") return "App Log (current hour)";
    if (node.path?.includes("Last%20hour")) return "App Log (last hour)";
  }
  return node.name;
}

function displayHint(node, paramValues = {}) {
  const resolved = resolveNode(node, paramValues);
  if (resolved.type === "scriptlet") {
    const path = extractNavigationPath(resolved.code);
    if (path) {
      return node.hostPattern ? toNavigatorPath(path) : path;
    }
    return node.hostPattern ? "Runs on the matched instance tab" : "Runs on the active tab";
  }
  if (resolved.type === "instance-path") {
    return resolved.hostPattern
      ? toNavigatorPath(resolved.path)
      : resolved.path;
  }
  if (resolved.type === "external") return resolved.url;
  return "";
}

function getLinkTemplate(node) {
  if (node.type === "instance-path") return node.path || "";
  if (node.type === "external") return node.url || "";
  if (node.type === "scriptlet") return node.code || "";
  return "";
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

function buildParameterDef(node, paramName) {
  const config = getParameterConfig(node, paramName) || {};
  return {
    name: paramName,
    label: config.label || paramName,
    placeholder: config.placeholder || paramName,
    default: config.default ?? "",
  };
}

function getParameterDefs(node) {
  const template = getLinkTemplate(node);
  const found = [...template.matchAll(PARAM_TOKEN_RE)].map((match) => match[1]);

  if (node.type === "scriptlet") {
    const scriptParams = [
      ...template.matchAll(/(^|[^\\])\$([a-zA-Z_][a-zA-Z0-9_]*)/g),
    ].map((match) => match[2]);
    found.push(...scriptParams);
  }

  const unique = [...new Set(found)];

  if (node.parameter && !Array.isArray(node.parameter)) {
    const name = node.parameter.name || "value";
    if (!unique.includes(name)) {
      unique.unshift(name);
    }
  }

  return unique.map((paramName) => buildParameterDef(node, paramName));
}

function applyParameters(template, values, { scriptlet = false } = {}) {
  let result = template;
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

function linkStorageKey(node) {
  if (node.id) {
    return node.id;
  }
  const sectionPrefix = node.sectionName ? `${node.sectionName}:` : "";
  return `${sectionPrefix}${node.type}:${node.name}:${getLinkTemplate(node)}`;
}

function resolveNode(node, paramValues) {
  const template = getLinkTemplate(node);
  if (!template || Object.keys(paramValues).length === 0) {
    return node;
  }

  const applied = applyParameters(template, paramValues, {
    scriptlet: node.type === "scriptlet",
  });
  if (node.type === "instance-path") {
    return { ...node, path: applied };
  }
  if (node.type === "external") {
    return { ...node, url: applied };
  }
  if (node.type === "scriptlet") {
    return { ...node, code: applied };
  }
  return node;
}

async function loadParamValues() {
  const stored = await browser.storage.local.get(PARAM_VALUES_KEY);
  return stored[PARAM_VALUES_KEY] || {};
}

async function saveParamValue(linkKey, paramName, value) {
  const allValues = await loadParamValues();
  const linkValues = allValues[linkKey] || {};
  linkValues[paramName] = value;
  allValues[linkKey] = linkValues;
  await browser.storage.local.set({ [PARAM_VALUES_KEY]: allValues });
}

function readParamValuesFromRow(row, parameterDefs) {
  const values = {};
  for (const def of parameterDefs) {
    const input = row.querySelector(`[data-param="${def.name}"]`);
    values[def.name] = input ? input.value.trim() : "";
  }
  return values;
}

function resolveParamValues(parameterDefs, rawValues) {
  const values = {};
  for (const def of parameterDefs) {
    const raw = rawValues[def.name];
    values[def.name] = raw !== "" ? raw : def.default;
  }
  return values;
}

function validateParamValues(parameterDefs, values) {
  const missing = parameterDefs
    .filter((def) => !values[def.name])
    .map((def) => def.label || def.name);
  if (missing.length === 0) {
    return null;
  }
  if (missing.length === 1) {
    return `Enter a value for ${missing[0]}.`;
  }
  return `Enter values for ${missing.join(", ")}.`;
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

async function loadCustomScripts() {
  const stored = await browser.storage.local.get(CUSTOM_SCRIPTS_KEY);
  return stored[CUSTOM_SCRIPTS_KEY] || [];
}

async function saveCustomScripts(scripts) {
  await browser.storage.local.set({ [CUSTOM_SCRIPTS_KEY]: scripts });
}

async function loadInjectOnLoad() {
  const stored = await browser.storage.local.get(INJECT_ON_LOAD_KEY);
  return stored[INJECT_ON_LOAD_KEY] || {};
}

async function setInjectOnLoad(linkKey, enabled) {
  const injectOnLoad = await loadInjectOnLoad();
  if (enabled) {
    injectOnLoad[linkKey] = true;
  } else {
    delete injectOnLoad[linkKey];
  }
  await browser.storage.local.set({ [INJECT_ON_LOAD_KEY]: injectOnLoad });
  await browser.runtime.sendMessage({ type: "REFRESH_INJECT" }).catch(() => {});
}

function defaultScriptName(code, scripts) {
  const navPath = extractNavigationPath(code);
  if (navPath) {
    const leaf = navPath.split(/[/?#]/)[0].replace(/\.do$/, "") || "page";
    return `Go to ${leaf}`;
  }

  return `Custom script ${scripts.length + 1}`;
}

function createParamInputs(parameterDefs, savedValues, linkKey, onEnter) {
  if (parameterDefs.length === 0) {
    return null;
  }

  const wrap = document.createElement("div");
  wrap.className = "param-inputs";

  for (const def of parameterDefs) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "param-input";
    input.dataset.param = def.name;
    input.placeholder = def.placeholder;
    input.title = def.label;
    const saved = savedValues[def.name];
    input.value = saved !== undefined ? saved : def.default;
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        onEnter();
      }
    });
    input.addEventListener("change", async () => {
      await saveParamValue(linkKey, def.name, input.value.trim());
    });
    wrap.appendChild(input);
  }

  return wrap;
}

function createLinkListHeader({ showRemove = false } = {}) {
  const header = document.createElement("div");
  header.className = "link-list-header";
  header.setAttribute("role", "row");

  const columns = [
    { className: "col-action", label: "Action" },
    { className: "col-params", label: "Params" },
    { className: "col-on-load", label: "On load" },
  ];
  if (showRemove) {
    columns.push({ className: "col-remove", label: "Remove" });
  }

  for (const column of columns) {
    const cell = document.createElement("span");
    cell.className = column.className;
    cell.textContent = column.label;
    header.appendChild(cell);
  }

  return header;
}

function createLinkRow(node, options = {}) {
  const parameterDefs = getParameterDefs(node);
  const linkKey = linkStorageKey(node);
  const savedValues = options.savedParamValues?.[linkKey] || {};

  const row = document.createElement("div");
  row.className = "link-row";
  if (options.showRemove) {
    row.classList.add("has-remove");
  }
  row.dataset.linkKey = linkKey;

  const actionCell = document.createElement("div");
  actionCell.className = "link-row-action";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "link-item";
  button.dataset.type = node.type;

  const badge = document.createElement("span");
  badge.className = `link-badge${node.type === "external" ? " external" : ""}`;
  badge.textContent =
    node.type === "scriptlet" ? "Run" : node.type === "external" ? "Web" : "Open";

  const labelWrap = document.createElement("span");
  labelWrap.className = "link-label";
  labelWrap.textContent = displayLabel(node);

  const hint = document.createElement("span");
  hint.className = "link-hint";
  const updateHint = () => {
    hint.textContent = displayHint(
      node,
      resolveParamValues(parameterDefs, readParamValuesFromRow(row, parameterDefs))
    );
  };
  updateHint();
  labelWrap.appendChild(hint);

  button.appendChild(badge);
  button.appendChild(labelWrap);
  button.addEventListener("click", () => activateLink(node, row));
  actionCell.appendChild(button);
  row.appendChild(actionCell);

  const paramsCell = document.createElement("div");
  paramsCell.className = "link-row-params";

  const paramInputs = createParamInputs(
    parameterDefs,
    savedValues,
    linkKey,
    () => activateLink(node, row)
  );
  if (paramInputs) {
    for (const input of paramInputs.querySelectorAll(".param-input")) {
      input.addEventListener("input", updateHint);
    }
    paramsCell.appendChild(paramInputs);
  }
  row.appendChild(paramsCell);

  const onLoadCell = document.createElement("div");
  onLoadCell.className = "link-row-on-load";

  if (node.type === "scriptlet" && !extractNavigationPath(node.code)) {
    const injectLabel = document.createElement("label");
    injectLabel.className = "inject-load";
    injectLabel.title = "Inject at document start on each navigation";

    const injectCheck = document.createElement("input");
    injectCheck.type = "checkbox";
    injectCheck.className = "inject-load-checkbox";
    injectCheck.checked = Boolean(options.injectOnLoad?.[linkKey]);
    injectCheck.addEventListener("click", (event) => event.stopPropagation());
    injectCheck.addEventListener("change", async () => {
      await setInjectOnLoad(linkKey, injectCheck.checked);
    });

    injectLabel.appendChild(injectCheck);
    onLoadCell.appendChild(injectLabel);
  }
  row.appendChild(onLoadCell);

  if (options.showRemove) {
    const removeCell = document.createElement("div");
    removeCell.className = "link-row-remove";

    if (options.onDelete) {
      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "delete-btn";
      deleteBtn.title = "Remove action";
      deleteBtn.textContent = "×";
      deleteBtn.addEventListener("click", options.onDelete);
      removeCell.appendChild(deleteBtn);
    }

    row.appendChild(removeCell);
  }

  return row;
}

function renderNodes(
  nodes,
  container,
  savedParamValues,
  inheritedHostPattern = null,
  sectionName = null,
  injectOnLoad = {},
  options = {}
) {
  for (const node of nodes) {
    const hostPattern = resolveHostPattern(node, inheritedHostPattern);
    if (node.children) {
      const folder = document.createElement("section");
      folder.className = "folder";

      const title = document.createElement("div");
      title.className = "folder-title";
      title.textContent = node.name;
      folder.appendChild(title);

      renderNodes(
        node.children,
        folder,
        savedParamValues,
        hostPattern,
        sectionName,
        injectOnLoad,
        options
      );
      container.appendChild(folder);
      continue;
    }

    container.appendChild(
      createLinkRow(
        { ...node, hostPattern, sectionName },
        { savedParamValues, injectOnLoad, showRemove: options.showRemove }
      )
    );
  }
}

function renderSectionTabs() {
  if (!sectionTabsEl || !linkSections) {
    return;
  }

  sectionTabsEl.replaceChildren();
  for (const section of linkSections) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "section-tab";
    tab.role = "tab";
    tab.textContent = section.name;
    tab.setAttribute(
      "aria-selected",
      section.name === activeSectionName ? "true" : "false"
    );
    tab.classList.toggle("active", section.name === activeSectionName);
    tab.addEventListener("click", async () => {
      activeSectionName = section.name;
      await browser.storage.local.set({ [SECTION_TAB_KEY]: activeSectionName });
      await renderAll();
    });
    sectionTabsEl.appendChild(tab);
  }
}

function renderCustomScripts(scripts, container, savedParamValues, injectOnLoad) {
  if (scripts.length === 0) {
    return;
  }

  const folder = document.createElement("section");
  folder.className = "folder";

  const title = document.createElement("div");
  title.className = "folder-title";
  title.textContent = "Custom scripts";
  folder.appendChild(title);

  for (const script of scripts) {
    const node = {
      id: script.id,
      name: script.name,
      type: "scriptlet",
      code: script.code,
      parameter: script.parameter,
      parameters: script.parameters,
    };

    folder.appendChild(
      createLinkRow(node, {
        savedParamValues,
        injectOnLoad,
        showRemove: true,
        onDelete: async (event) => {
          event.stopPropagation();
          const nextScripts = scripts.filter((item) => item.id !== script.id);
          await saveCustomScripts(nextScripts);
          const nextInject = await loadInjectOnLoad();
          delete nextInject[script.id];
          await browser.storage.local.set({ [INJECT_ON_LOAD_KEY]: nextInject });
          await renderAll();
        },
      })
    );
  }

  container.appendChild(folder);
}

async function renderAll() {
  linksEl.replaceChildren();
  const savedParamValues = await loadParamValues();
  const injectOnLoad = await loadInjectOnLoad();
  const customScripts = await loadCustomScripts();
  const showRemove = customScripts.length > 0;
  const section = getActiveSection();

  const list = document.createElement("div");
  list.className = "link-list";
  if (showRemove) {
    list.classList.add("has-remove");
  }
  list.appendChild(createLinkListHeader({ showRemove }));

  if (section) {
    renderNodes(
      section.children,
      list,
      savedParamValues,
      section.hostPattern,
      section.name,
      injectOnLoad,
      { showRemove }
    );
  }
  renderCustomScripts(customScripts, list, savedParamValues, injectOnLoad);
  linksEl.appendChild(list);
  renderSectionTabs();
}

async function addCustomScript() {
  hideMessage();

  const code = normalizeScriptInput(scriptCodeInput.value);
  if (!code) {
    showMessage("Paste a script before adding an action.");
    scriptCodeInput.focus();
    return;
  }

  const scripts = await loadCustomScripts();
  const name = scriptNameInput.value.trim() || defaultScriptName(code, scripts);
  const nextScripts = scripts.concat({
    id: crypto.randomUUID(),
    name,
    code,
    createdAt: Date.now(),
  });

  await saveCustomScripts(nextScripts);
  scriptNameInput.value = "";
  scriptCodeInput.value = "";
  await renderAll();
  showMessage(`Added "${name}".`);
}

async function runScriptlet(tabId, code) {
  await browser.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (source) => {
      const runner = new Function(source);
      runner();
    },
    args: [code],
  });
}

async function openInstancePath(origin, path, tab, hostPattern) {
  const url = hostPattern
    ? toNavigatorUrl(origin, path)
    : resolvePathOnTab(tab, path);

  if (tab?.id) {
    await browser.tabs.update(tab.id, {
      url,
      active: Boolean(hostPattern),
    });
    return;
  }

  await browser.tabs.create({ url, active: true });
}

async function activateLink(node, row = null) {
  hideMessage();

  try {
    const parameterDefs = getParameterDefs(node);
    const rawValues =
      row && parameterDefs.length > 0
        ? readParamValuesFromRow(row, parameterDefs)
        : {};
    const paramValues = resolveParamValues(parameterDefs, rawValues);
    const validationError = validateParamValues(parameterDefs, paramValues);
    if (validationError) {
      showMessage(validationError);
      return;
    }

    const linkKey = linkStorageKey(node);
    for (const def of parameterDefs) {
      await saveParamValue(linkKey, def.name, paramValues[def.name]);
    }

    const resolved = resolveNode(node, paramValues);

    if (resolved.type === "external") {
      await browser.tabs.create({ url: resolved.url, active: true });
      window.close();
      return;
    }

    const hostPattern = resolved.hostPattern ?? null;
    const { tab, origin } = await getTargetTab(hostPattern);

    if (resolved.type === "scriptlet") {
      const navPath = extractNavigationPath(resolved.code);
      if (navPath) {
        await openInstancePath(origin, navPath, tab, hostPattern);
        window.close();
        return;
      }

      if (hostPattern) {
        await browser.tabs.update(tab.id, { active: true });
      }
      await runScriptlet(tab.id, resolved.code);
      window.close();
      return;
    }

    if (resolved.type === "instance-path") {
      await openInstancePath(origin, resolved.path, tab, hostPattern);
      window.close();
    }
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

async function initAddScriptCollapse() {
  const stored = await browser.storage.local.get(ADD_SCRIPT_EXPANDED_KEY);
  setAddScriptExpanded(stored[ADD_SCRIPT_EXPANDED_KEY] === true);

  addScriptToggle.addEventListener("click", async () => {
    const expanded = addScriptToggle.getAttribute("aria-expanded") !== "true";
    setAddScriptExpanded(expanded);
    await browser.storage.local.set({ [ADD_SCRIPT_EXPANDED_KEY]: expanded });
  });
}

function setAddScriptExpanded(expanded) {
  addScriptSection.classList.toggle("is-collapsed", !expanded);
  addScriptToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
  addScriptPanel.hidden = !expanded;
}

async function init() {
  const raw = await fetch(browser.runtime.getURL("data/links.json")).then(
    (response) => response.json()
  );
  linkSections = parseLinkSections(raw);
  const stored = await browser.storage.local.get(SECTION_TAB_KEY);
  activeSectionName =
    stored[SECTION_TAB_KEY] ||
    linkSections.find((section) => section.name === "ServiceNow")?.name ||
    linkSections[0]?.name ||
    null;

  const activeTab = await getActiveTab();
  if (activeTab?.url) {
    instanceStatusEl.textContent = `Active tab: ${new URL(activeTab.url).origin}`;
  } else {
    instanceStatusEl.textContent = "No active tab";
  }

  addScriptBtn.addEventListener("click", () => {
    addCustomScript();
  });

  scriptCodeInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      addCustomScript();
    }
  });

  await initAddScriptCollapse();
  await renderAll();
}

init();
