const SN_HOST = /\.service-now\.com$/i;
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

function extractNavigationPath(code) {
  const match = code.match(/window\.location\.href\s*=\s*(['"])(.*?)\1/);
  return match ? match[2] : null;
}

const CUSTOM_SCRIPTS_KEY = "customScripts";
const PARAM_VALUES_KEY = "linkParamValues";
const PARAM_TOKEN_RE = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;

const linksEl = document.getElementById("links");
const instanceStatusEl = document.getElementById("instance-status");
const messageEl = document.getElementById("message");
const scriptNameInput = document.getElementById("script-name");
const scriptCodeInput = document.getElementById("script-code");
const addScriptBtn = document.getElementById("add-script-btn");

let linkTree = null;

function showMessage(text) {
  messageEl.textContent = text;
  messageEl.classList.remove("hidden");
}

function hideMessage() {
  messageEl.classList.add("hidden");
}

function isServiceNowUrl(urlString) {
  try {
    return SN_HOST.test(new URL(urlString).hostname);
  } catch {
    return false;
  }
}

async function getActiveTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function resolveInstanceOrigin() {
  const tab = await getActiveTab();
  if (tab?.url && isServiceNowUrl(tab.url)) {
    const origin = new URL(tab.url).origin;
    await browser.storage.local.set({ lastInstance: origin });
    return { origin, tabId: tab.id };
  }

  const { lastInstance } = await browser.storage.local.get("lastInstance");
  if (lastInstance) {
    return { origin: lastInstance, tabId: null };
  }

  return { origin: null, tabId: null };
}

async function findServiceNowTab(preferredOrigin) {
  const tabs = await browser.tabs.query({ currentWindow: true });
  const snTabs = tabs.filter((tab) => tab.url && isServiceNowUrl(tab.url));

  if (preferredOrigin) {
    const match = snTabs.find(
      (tab) => new URL(tab.url).origin === preferredOrigin
    );
    if (match) return match;
  }

  return snTabs[0] || null;
}

async function ensureServiceNowTab(origin) {
  const existing = await findServiceNowTab(origin);
  if (existing) {
    return existing;
  }

  if (!origin) {
    throw new Error(
      "Open a ServiceNow instance tab first, or visit one so the extension can remember it."
    );
  }

  return browser.tabs.create({ url: `${origin}/navpage.do`, active: false });
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

async function getTargetServiceNowTab() {
  const activeTab = await getActiveTab();
  if (activeTab?.url && isServiceNowUrl(activeTab.url)) {
    const origin = new URL(activeTab.url).origin;
    await browser.storage.local.set({ lastInstance: origin });
    return { tab: activeTab, origin };
  }

  const { lastInstance } = await browser.storage.local.get("lastInstance");
  const tab = await ensureServiceNowTab(lastInstance || null);
  const loadedTab =
    tab.status === "complete" ? tab : await waitForTabLoad(tab.id);
  const origin = new URL(loadedTab.url).origin;
  await browser.storage.local.set({ lastInstance: origin });
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
    return path ? toNavigatorPath(path) : "Runs on the current instance tab";
  }
  if (resolved.type === "instance-path") return toNavigatorPath(resolved.path);
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
  return `${node.type}:${node.name}:${getLinkTemplate(node)}`;
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

function createLinkRow(node, options = {}) {
  const parameterDefs = getParameterDefs(node);
  const linkKey = linkStorageKey(node);
  const savedValues = options.savedParamValues?.[linkKey] || {};

  const row = document.createElement("div");
  row.className = "link-row";
  row.dataset.linkKey = linkKey;

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
  row.appendChild(button);

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
    row.appendChild(paramInputs);
  }

  if (options.onDelete) {
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "delete-btn";
    deleteBtn.title = "Remove action";
    deleteBtn.textContent = "×";
    deleteBtn.addEventListener("click", options.onDelete);
    row.appendChild(deleteBtn);
  }

  return row;
}

function renderNodes(nodes, container, savedParamValues) {
  for (const node of nodes) {
    if (node.children) {
      const folder = document.createElement("section");
      folder.className = "folder";

      const title = document.createElement("div");
      title.className = "folder-title";
      title.textContent = node.name;
      folder.appendChild(title);

      renderNodes(node.children, folder, savedParamValues);
      container.appendChild(folder);
      continue;
    }

    container.appendChild(createLinkRow(node, { savedParamValues }));
  }
}

function renderCustomScripts(scripts, container, savedParamValues) {
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
        onDelete: async (event) => {
          event.stopPropagation();
          const nextScripts = scripts.filter((item) => item.id !== script.id);
          await saveCustomScripts(nextScripts);
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
  if (linkTree) {
    renderNodes(linkTree.children, linksEl, savedParamValues);
  }
  renderCustomScripts(await loadCustomScripts(), linksEl, savedParamValues);
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

async function openInstancePath(origin, path, tabId) {
  const url = toNavigatorUrl(origin, path);

  if (tabId) {
    await browser.tabs.update(tabId, { url, active: true });
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

    const { tab, origin } = await getTargetServiceNowTab();

    if (resolved.type === "scriptlet") {
      const navPath = extractNavigationPath(resolved.code);
      if (navPath) {
        await openInstancePath(origin, navPath, tab.id);
        window.close();
        return;
      }

      await browser.tabs.update(tab.id, { active: true });
      await runScriptlet(tab.id, resolved.code);
      window.close();
      return;
    }

    if (resolved.type === "instance-path") {
      await openInstancePath(origin, resolved.path, tab.id);
      window.close();
    }
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

async function init() {
  linkTree = await fetch(browser.runtime.getURL("data/links.json")).then(
    (response) => response.json()
  );

  const { origin } = await resolveInstanceOrigin();

  if (origin) {
    instanceStatusEl.textContent = `Instance: ${origin}`;
  } else {
    instanceStatusEl.textContent =
      "No ServiceNow tab detected — instance links use your last visited instance.";
    showMessage(
      "Open any *.service-now.com tab so scriptlets and instance paths target the right instance."
    );
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

  await renderAll();
}

init();
