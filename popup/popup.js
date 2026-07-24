const { toNavigatorPath, toNavigatorUrl, resolvePathOnTab, isAbsoluteUrl, resolvePathUrl, resolveDerivedUrl, resolveDerivedLink, evaluateNavScript, resolveAbsoluteUrl, resolveNav, performNavigation } =
  globalThis.SnLinksNav;

const CUSTOM_SCRIPTS_KEY = "customScripts";
const LAST_ORIGINS_KEY = "lastOrigins";
const hostPatternCache = new Map();
const PARAM_VALUES_KEY = "linkParamValues";
const SECTION_TAB_KEY = "activeSectionTab";
const ADD_SCRIPT_EXPANDED_KEY = "addScriptExpanded";
const INJECT_ON_LOAD_KEY = "injectOnLoad";
const POPUP_SIZE_KEY = "popupSize";
const POPUP_MIN_WIDTH = 420;
const POPUP_MIN_HEIGHT = 400;
const POPUP_MAX_WIDTH = 800;
const POPUP_MAX_HEIGHT = 600;
const POPUP_DEFAULT_WIDTH = 420;
const POPUP_DEFAULT_HEIGHT = 560;

const sectionTabsEl = document.getElementById("section-tabs");
const linksEl = document.getElementById("links");
const instanceStatusEl = document.getElementById("instance-status");
const cspDisableLabel = document.getElementById("csp-disable-label");
const cspDisableCheckbox = document.getElementById("csp-disable-checkbox");
const injectOnLoadEnabledEl = document.getElementById("inject-on-load-enabled");
const networkHooksEnabledEl = document.getElementById("network-hooks-enabled");
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
    const url = new URL(urlString);
    const re = getHostPatternRegex(pattern);
    return re.test(url.hostname) || re.test(url.href);
  } catch {
    return false;
  }
}

function extractNavigationPath(code) {
  const match = code.match(/window\.location\.href\s*=\s*(['"])(.*?)\1/);
  return match ? match[2] : null;
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

async function findMatchingTab(hostPattern, preferredOrigin, activeTab) {
  const tabs = await browser.tabs.query({ currentWindow: true });
  const active = activeTab ?? (await getActiveTab());
  const activeIndex = active?.index ?? 0;

  const matchingTabs = tabs.filter(
    (tab) => tab.url && matchesHostPattern(tab.url, hostPattern)
  );

  if (matchingTabs.length === 0) {
    return null;
  }

  function distanceFromActive(tab) {
    return Math.abs(tab.index - activeIndex);
  }

  function nearestTab(candidates) {
    return [...candidates].sort((a, b) => {
      const dist = distanceFromActive(a) - distanceFromActive(b);
      if (dist !== 0) {
        return dist;
      }
      return a.index - b.index;
    })[0];
  }

  if (preferredOrigin) {
    const originMatches = matchingTabs.filter(
      (tab) => new URL(tab.url).origin === preferredOrigin
    );
    if (originMatches.length > 0) {
      return nearestTab(originMatches);
    }
  }

  return nearestTab(matchingTabs);
}

async function ensureMatchingTab(hostPattern, origin, activeTab) {
  const existing = await findMatchingTab(hostPattern, origin, activeTab);
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
  const tab = await ensureMatchingTab(hostPattern, rememberedOrigin, activeTab);
  const loadedTab =
    tab.status === "complete" ? tab : await waitForTabLoad(tab.id);
  const origin = new URL(loadedTab.url).origin;
  await rememberOrigin(hostPattern, origin);
  return { tab: loadedTab, origin };
}

function displayLabel(node) {
  if (node.name === "App Log | ServiceNow") {
    if (node.path?.includes("Last%20hour")) return "App Log (last hour)";
    return "App Log (current hour)";
  }
  return node.name;
}

function linkBadgeLabel(node) {
  if (node.type === "scriptlet") return "Run";
  if (node.type === "derived-url") return "Derive";
  if (node.type === "navigate") {
    return isAbsoluteUrl(node.path || "") ? "Web" : "Open";
  }
  return "Open";
}

function linkBadgeClass(node) {
  let classes = "link-badge";
  if (node.type === "derived-url") classes += " derived-url";
  if (node.type === "navigate" && isAbsoluteUrl(node.path || "")) {
    classes += " absolute-url";
  }
  return classes;
}

function displayHint(node, paramValues = {}) {
  const resolved = resolveNode(node, paramValues);
  if (resolved.type === "scriptlet") {
    if (resolved.nav) {
      return "Navigates via extension";
    }
    const path = extractNavigationPath(resolved.code);
    if (path) {
      return node.hostPattern ? toNavigatorPath(path) : path;
    }
    return node.hostPattern ? "Runs on the matched instance tab" : "Runs on the active tab";
  }
  if (resolved.type === "derived-url") {
    if (resolved.path) {
      if (isAbsoluteUrl(resolved.path)) {
        return resolved.path;
      }
      return resolved.hostPattern
        ? toNavigatorPath(resolved.path)
        : resolved.path;
    }
    return resolved.url.replace(/\{encode:[^}]+\}/g, "…").replace(/\{[^}]+\}/g, "…");
  }
  if (resolved.type === "navigate") {
    const path = resolved.path || "";
    if (isAbsoluteUrl(path)) {
      return path;
    }
    return resolved.hostPattern ? toNavigatorPath(path) : path;
  }
  return "";
}

function getLinkTemplate(node) {
  if (node.type === "navigate" || node.type === "derived-url") {
    return node.url || node.path || "";
  }
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
    optional: Boolean(config.optional),
    choices: Array.isArray(config.choices) ? config.choices : null,
  };
}

function bindParamInput(input, def, linkKey, onEnter) {
  input.classList.add("param-input");
  input.dataset.param = def.name;
  input.placeholder = def.placeholder;
  input.title = def.label;
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
}

let openCombobox = null;

function closeOpenCombobox() {
  if (!openCombobox) {
    return;
  }
  openCombobox.list.hidden = true;
  if (openCombobox.onScroll) {
    window.removeEventListener("scroll", openCombobox.onScroll, true);
  }
  openCombobox = null;
}

function positionComboboxList(root, list) {
  const rect = root.getBoundingClientRect();
  const width = Math.max(176, rect.width + 72);
  const left = Math.max(8, rect.right - width);

  list.style.width = `${width}px`;
  list.style.left = `${left}px`;
  list.style.top = `${rect.bottom + 2}px`;
  list.style.right = "auto";
}

function createChoiceCombobox(def, savedValues, linkKey, onEnter) {
  const root = document.createElement("div");
  root.className = "param-combobox";

  const field = document.createElement("div");
  field.className = "param-combobox-field";

  const input = document.createElement("input");
  input.type = "text";
  const saved = savedValues[def.name];
  input.value = saved !== undefined ? saved : def.default;
  bindParamInput(input, def, linkKey, onEnter);
  input.classList.add("param-combobox-input");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "param-combobox-toggle";
  toggle.setAttribute("aria-label", `Choose ${def.label}`);
  toggle.textContent = "▾";

  const list = document.createElement("ul");
  list.className = "param-combobox-list";
  list.hidden = true;
  list.setAttribute("role", "listbox");

  function renderList() {
    const query = input.value.trim().toLowerCase();
    list.replaceChildren();
    const matches = def.choices.filter(
      (choice) => !query || choice.toLowerCase().includes(query)
    );
    if (matches.length === 0) {
      list.hidden = true;
      if (openCombobox?.root === root) {
        openCombobox = null;
      }
      return;
    }

    for (const choice of matches) {
      const item = document.createElement("li");
      item.className = "param-combobox-option";
      item.textContent = choice;
      item.setAttribute("role", "option");
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        input.value = choice;
        closeOpenCombobox();
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      list.appendChild(item);
    }
  }

  function openList() {
    renderList();
    if (list.children.length === 0) {
      return;
    }
    closeOpenCombobox();
    positionComboboxList(root, list);
    list.hidden = false;
    const onScroll = () => closeOpenCombobox();
    window.addEventListener("scroll", onScroll, true);
    openCombobox = { root, list, onScroll };
  }

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (list.hidden) {
      input.focus();
      openList();
    } else {
      closeOpenCombobox();
    }
  });

  input.addEventListener("focus", openList);
  input.addEventListener("input", () => {
    if (!list.hidden || document.activeElement === input) {
      openList();
    }
  });
  input.addEventListener("blur", () => {
    window.setTimeout(closeOpenCombobox, 120);
  });

  field.appendChild(input);
  field.appendChild(toggle);
  root.appendChild(field);
  root.appendChild(list);
  return root;
}

function getParameterDefs(node) {
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

  return names.map((paramName) => buildParameterDef(node, paramName));
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
    .filter((def) => !def.optional && !values[def.name])
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
    if (def.choices?.length) {
      wrap.appendChild(createChoiceCombobox(def, savedValues, linkKey, onEnter));
      continue;
    }

    const input = document.createElement("input");
    input.type = "text";
    const saved = savedValues[def.name];
    input.value = saved !== undefined ? saved : def.default;
    bindParamInput(input, def, linkKey, onEnter);
    wrap.appendChild(input);
  }

  return wrap;
}

function nodeHasParams(node) {
  return getParameterDefs(node).length > 0;
}

function treeHasParams(nodes) {
  for (const node of nodes) {
    if (node.children) {
      if (treeHasParams(node.children)) {
        return true;
      }
      continue;
    }
    if (nodeHasParams(node)) {
      return true;
    }
  }
  return false;
}

function nodeHasOnLoad(node) {
  return (
    node.type === "scriptlet" &&
    !node.nav &&
    !extractNavigationPath(node.code || "")
  );
}

function treeHasOnLoad(nodes) {
  for (const node of nodes) {
    if (node.children) {
      if (treeHasOnLoad(node.children)) {
        return true;
      }
      continue;
    }
    if (nodeHasOnLoad(node)) {
      return true;
    }
  }
  return false;
}

function createLinkListHeader({
  showRemove = false,
  showParams = false,
  showOnLoad = false,
} = {}) {
  const header = document.createElement("div");
  header.className = "link-list-header";
  header.setAttribute("role", "row");

  const actionHeader = document.createElement("span");
  actionHeader.className = "col-action";
  actionHeader.textContent = "Action";
  header.appendChild(actionHeader);

  if (showParams) {
    const paramsHeader = document.createElement("span");
    paramsHeader.className = "col-params";
    paramsHeader.textContent = "Params";
    header.appendChild(paramsHeader);
  }

  if (showOnLoad) {
    const onLoadHeader = document.createElement("span");
    onLoadHeader.className = "col-on-load";
    onLoadHeader.textContent = "On load";
    header.appendChild(onLoadHeader);
  }

  if (showRemove) {
    const removeHeader = document.createElement("span");
    removeHeader.className = "col-remove";
    removeHeader.textContent = "Remove";
    header.appendChild(removeHeader);
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
  badge.className = linkBadgeClass(node);
  badge.textContent = linkBadgeLabel(node);

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
    row.classList.add("has-params");
  }

  row.appendChild(actionCell);
  if (paramInputs) {
    row.appendChild(paramsCell);
  }

  const onLoadCell = document.createElement("div");
  onLoadCell.className = "link-row-on-load";
  const hasOnLoad = nodeHasOnLoad(node);

  if (hasOnLoad) {
    row.classList.add("has-on-load");
    const injectLabel = document.createElement("label");
    injectLabel.className = "inject-load";
    const hostHint = node.hostPattern
      ? `Inject at document start when tab URL matches /${node.hostPattern}/`
      : "Inject at document start on every page";
    injectLabel.title = hostHint;

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
    row.appendChild(onLoadCell);
  }

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
  const showParams =
    customScripts.some((script) =>
      nodeHasParams({
        type: "scriptlet",
        code: script.code,
        parameter: script.parameter,
        parameters: script.parameters,
      })
    ) || (section ? treeHasParams(section.children) : false);
  const showOnLoad =
    customScripts.some((script) =>
      nodeHasOnLoad({ type: "scriptlet", code: script.code })
    ) || (section ? treeHasOnLoad(section.children) : false);

  const list = document.createElement("div");
  list.className = "link-list";
  if (showRemove) {
    list.classList.add("has-remove");
  }
  if (showParams) {
    list.classList.add("has-params");
  }
  if (showOnLoad) {
    list.classList.add("has-on-load");
  }
  list.appendChild(createLinkListHeader({ showRemove, showParams, showOnLoad }));

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
  const response = await browser.runtime.sendMessage({
    type: "RUN_SCRIPTLET",
    tabId,
    code,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Script injection failed.");
  }
}

function resolveNavigationUrl(resolved, tab, origin, hostPattern, paramValues) {
  if (resolved.type === "derived-url") {
    return resolveDerivedLink(resolved, tab, origin, hostPattern, paramValues);
  }
  if (resolved.type === "navigate") {
    return resolvePathUrl(resolved.path, tab, origin, hostPattern);
  }
  if (resolved.type === "scriptlet" && resolved.nav) {
    const result = evaluateNavScript(resolved.code, tab.url);
    return resolveAbsoluteUrl(result, tab, origin, hostPattern);
  }
  return null;
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

    if (resolved.type === "scriptlet" && !resolved.nav) {
      const navPath = extractNavigationPath(resolved.code);
      if (navPath) {
        const hostPattern = resolved.hostPattern ?? null;
        const { tab, origin } = await getTargetTab(hostPattern);
        const url = hostPattern
          ? toNavigatorUrl(origin, navPath)
          : resolvePathOnTab(tab, navPath);
        await performNavigation("same-tab", url, tab, hostPattern);
        window.close();
        return;
      }

      const hostPattern = resolved.hostPattern ?? null;
      const { tab } = await getTargetTab(hostPattern);
      if (hostPattern) {
        await browser.tabs.update(tab.id, { active: true });
      }
      await runScriptlet(tab.id, resolved.code);
      window.close();
      return;
    }

    const hostPattern = resolved.hostPattern ?? null;
    const { tab, origin } = await getTargetTab(hostPattern);
    const url = resolveNavigationUrl(
      resolved,
      tab,
      origin,
      hostPattern,
      paramValues
    );

    if (url === null) {
      window.close();
      return;
    }

    const nav = resolveNav(resolved);
    if (!nav) {
      throw new Error(`Navigation mode is required for ${resolved.type} links.`);
    }

    await performNavigation(nav, url, tab, hostPattern);
    window.close();
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

async function initPopupSize() {
  const stored = await browser.storage.local.get(POPUP_SIZE_KEY);
  const size = stored[POPUP_SIZE_KEY];

  const width =
    size?.width >= POPUP_MIN_WIDTH ? size.width : POPUP_DEFAULT_WIDTH;
  const height =
    size?.height >= POPUP_MIN_HEIGHT ? size.height : POPUP_DEFAULT_HEIGHT;

  applyPopupSize(width, height);
  initResizeHandle();

  let saveTimer = null;
  new ResizeObserver(() => {
    if (popupResizeObserverPaused) {
      return;
    }
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(savePopupSize, 200);
  }).observe(document.body);
}

let popupResizeObserverPaused = false;
let popupResizeFrame = null;
let pendingPopupSize = null;

function clampPopupSize(width, height) {
  return {
    width: Math.min(POPUP_MAX_WIDTH, Math.max(POPUP_MIN_WIDTH, Math.round(width))),
    height: Math.min(
      POPUP_MAX_HEIGHT,
      Math.max(POPUP_MIN_HEIGHT, Math.round(height))
    ),
  };
}

function applyPopupSize(width, height) {
  const size = clampPopupSize(width, height);
  document.body.style.width = `${size.width}px`;
  document.body.style.height = `${size.height}px`;
  return size;
}

function schedulePopupSize(width, height) {
  pendingPopupSize = { width, height };
  if (popupResizeFrame !== null) {
    return;
  }
  popupResizeFrame = requestAnimationFrame(() => {
    popupResizeFrame = null;
    if (!pendingPopupSize) {
      return;
    }
    applyPopupSize(pendingPopupSize.width, pendingPopupSize.height);
    pendingPopupSize = null;
  });
}

async function savePopupSize() {
  await browser.storage.local.set({
    [POPUP_SIZE_KEY]: {
      width: document.body.offsetWidth,
      height: document.body.offsetHeight,
    },
  });
}

function initResizeHandle() {
  const handle = document.getElementById("resize-handle");
  if (!handle) {
    return;
  }

  handle.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    popupResizeObserverPaused = true;
    document.body.classList.add("is-resizing");

    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = document.body.offsetWidth;
    const startHeight = document.body.offsetHeight;

    function onMouseMove(moveEvent) {
      schedulePopupSize(
        startWidth - (moveEvent.clientX - startX),
        startHeight + (moveEvent.clientY - startY)
      );
    }

    function onMouseUp() {
      popupResizeObserverPaused = false;
      document.body.classList.remove("is-resizing");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);

      if (popupResizeFrame !== null) {
        cancelAnimationFrame(popupResizeFrame);
        popupResizeFrame = null;
      }
      if (pendingPopupSize) {
        applyPopupSize(pendingPopupSize.width, pendingPopupSize.height);
        pendingPopupSize = null;
      }

      savePopupSize();
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });
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

async function syncCspDisableUi(tab) {
  if (!cspDisableCheckbox || !cspDisableLabel) {
    return;
  }

  const usable =
    tab?.id != null &&
    typeof tab.url === "string" &&
    /^https?:\/\//i.test(tab.url);

  cspDisableCheckbox.disabled = !usable;
  cspDisableLabel.classList.toggle("is-disabled", !usable);

  if (!usable) {
    cspDisableCheckbox.checked = false;
    return;
  }

  const response = await browser.runtime.sendMessage({
    type: "GET_CSP_DISABLED",
    tabId: tab.id,
  });
  cspDisableCheckbox.checked = Boolean(response?.disabled);
}

async function initExtensionSettingsControls() {
  const response = await browser.runtime.sendMessage({
    type: "GET_EXTENSION_SETTINGS",
  });
  const settings = response?.settings || {
    networkHooksEnabled: true,
    injectOnLoadEnabled: true,
  };

  if (injectOnLoadEnabledEl) {
    injectOnLoadEnabledEl.checked = settings.injectOnLoadEnabled !== false;
    injectOnLoadEnabledEl.addEventListener("change", async () => {
      await browser.runtime.sendMessage({
        type: "SET_EXTENSION_SETTINGS",
        settings: { injectOnLoadEnabled: injectOnLoadEnabledEl.checked },
      });
    });
  }

  if (networkHooksEnabledEl) {
    networkHooksEnabledEl.checked = settings.networkHooksEnabled !== false;
    networkHooksEnabledEl.addEventListener("change", async () => {
      await browser.runtime.sendMessage({
        type: "SET_EXTENSION_SETTINGS",
        settings: { networkHooksEnabled: networkHooksEnabledEl.checked },
      });
    });
  }
}

async function initCspDisableControl() {
  if (!cspDisableCheckbox) {
    return;
  }

  const activeTab = await getActiveTab();
  await syncCspDisableUi(activeTab);

  cspDisableCheckbox.addEventListener("change", async () => {
    const tab = await getActiveTab();
    if (!tab?.id || cspDisableCheckbox.disabled) {
      return;
    }

    await browser.runtime.sendMessage({
      type: "SET_CSP_DISABLED",
      tabId: tab.id,
      disabled: cspDisableCheckbox.checked,
    });

    if (cspDisableCheckbox.checked) {
      showMessage("CSP disabled for this tab. Reload the page to apply.");
    } else {
      hideMessage();
    }
  });
}

async function openNetworkRulesWindow() {
  const rulesUrl = browser.runtime.getURL("rules/rules.html");
  const windows = await browser.windows.getAll({ populate: true });
  for (const win of windows) {
    for (const tab of win.tabs || []) {
      if (tab.url === rulesUrl && win.id != null) {
        await browser.windows.update(win.id, { focused: true });
        if (tab.id != null) {
          await browser.tabs.update(tab.id, { active: true });
        }
        return;
      }
    }
  }

  await browser.windows.create({
    url: rulesUrl,
    type: "popup",
    width: 960,
    height: 760,
  });
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

  const networkRulesBtn = document.getElementById("network-rules-btn");
  if (networkRulesBtn) {
    networkRulesBtn.addEventListener("click", () => {
      openNetworkRulesWindow();
    });
  }

  document.addEventListener("click", (event) => {
    if (openCombobox && !openCombobox.root.contains(event.target)) {
      closeOpenCombobox();
    }
  });

  scriptCodeInput.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      addCustomScript();
    }
  });

  await initPopupSize();
  await initAddScriptCollapse();
  await initExtensionSettingsControls();
  await initCspDisableControl();
  await renderAll();
}

init();
