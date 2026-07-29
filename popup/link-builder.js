import {
  wireBuilderFieldUi,
  updateHostPatternFieldVisibility,
  updateParameterModeVisibility,
  readHostPattern,
  populateHostPattern,
  readParameterFields,
  populateParameterFields,
  clearParameterFields,
  populateExtractFields,
  readExtractFields,
  clearExtractFields,
  getBuilderFieldElements,
  setFieldVisible,
} from "./link-builder-fields.js";
import { getFieldValue, setFieldValue } from "../lib/codemirror-fields.bundle.js";

const { ensureLinkId } = globalThis.SnLinksLinkCatalog;
const { normalizeScriptInput, defaultScriptName } = globalThis.SnLinksLinkModel;

const NAV_OPTIONS = {
  scriptlet: [
    { value: "", label: "Default" },
    { value: "same-tab", label: "Same tab" },
    { value: "foreground", label: "New tab (foreground)" },
    { value: "background", label: "New tab (background)" },
    { value: "fetch", label: "Download (fetch)" },
  ],
  navigate: [
    { value: "same-tab", label: "Same tab" },
    { value: "foreground", label: "New tab (foreground)" },
    { value: "background", label: "New tab (background)" },
    { value: "fetch", label: "Download (fetch)" },
  ],
  "derived-url": [
    { value: "same-tab", label: "Same tab" },
    { value: "foreground", label: "New tab (foreground)" },
    { value: "background", label: "New tab (background)" },
    { value: "fetch", label: "Download (fetch)" },
  ],
};

function defaultUrlName(path, existingCount) {
  try {
    if (/^https?:\/\//i.test(path)) {
      const url = new URL(path);
      const suffix = url.pathname !== "/" ? url.pathname : "";
      return `Open ${url.hostname}${suffix}`.slice(0, 72);
    }
    const leaf = path.split(/[/?#]/).filter(Boolean).pop() || "page";
    return `Go to ${leaf}`;
  } catch {
    return `Custom link ${existingCount + 1}`;
  }
}

export function buildQuickLinkNode(
  rawInput,
  nameInput,
  existingNodes = [],
  mode = "link"
) {
  const input = String(rawInput ?? "").trim();
  if (!input) {
    throw new Error("Paste a script or URL before adding an action.");
  }

  if (mode === "link") {
    const node = {
      name: nameInput.trim() || defaultUrlName(input, existingNodes.length),
      type: "navigate",
      path: input,
      nav: input.startsWith("/") ? "same-tab" : "foreground",
    };
    return ensureLinkId(node);
  }

  const code = normalizeScriptInput(input);
  const scriptlets = existingNodes.filter((node) => node.type === "scriptlet");
  return ensureLinkId({
    name: nameInput.trim() || defaultScriptName(code, scriptlets),
    type: "scriptlet",
    code,
  });
}

export function pathFromTabUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (!/^https?:$/i.test(url.protocol)) {
      return urlString;
    }
    return `${url.pathname}${url.search}${url.hash}` || "/";
  } catch {
    return urlString;
  }
}

export function hostPatternFromUrl(urlString) {
  try {
    const hostname = new URL(urlString).hostname;
    if (!hostname) {
      return null;
    }
    return `^${hostname.replace(/\./g, "\\.")}$`;
  } catch {
    return null;
  }
}

export function buildPathTemplateFromUrl(urlString) {
  try {
    const url = new URL(urlString);
    if (!/^https?:$/i.test(url.protocol)) {
      return {
        path: urlString,
        parameter: undefined,
        parameters: undefined,
      };
    }

    const paramEntries = [...new URLSearchParams(url.search).entries()];
    const pathname = url.pathname || "/";
    const hash = url.hash || "";

    if (paramEntries.length === 0) {
      return {
        path: `${pathname}${hash}`,
        parameter: undefined,
        parameters: undefined,
      };
    }

    const parameters = {};
    const queryParts = [];
    for (const [name, value] of paramEntries) {
      queryParts.push(`${encodeURIComponent(name)}={${name}}`);
      parameters[name] = { default: value, placeholder: name };
    }

    const path = `${pathname}?${queryParts.join("&")}${hash}`;
    if (paramEntries.length === 1) {
      const [name, value] = paramEntries[0];
      return {
        path,
        parameter: { name, default: value, placeholder: name },
        parameters: undefined,
      };
    }

    return { path, parameter: undefined, parameters };
  } catch {
    return {
      path: pathFromTabUrl(urlString),
      parameter: undefined,
      parameters: undefined,
    };
  }
}

export function buildPrefillFromTab(tab) {
  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
    return null;
  }

  const { path, parameter, parameters } = buildPathTemplateFromUrl(tab.url);
  const title = tab.title?.trim() || defaultUrlName(path, 0);
  return {
    name: title,
    displayName: title,
    path,
    parameter,
    parameters,
    hostPattern: hostPatternFromUrl(tab.url),
    absoluteUrl: tab.url,
  };
}

export async function captureTabPrefillForBuilder() {
  let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!buildPrefillFromTab(tab)) {
    [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  }
  return buildPrefillFromTab(tab);
}

async function findBrowsingTab() {
  const windows = await browser.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const ordered = [...windows].sort((a, b) => Number(b.focused) - Number(a.focused));

  for (const win of ordered) {
    const activeTab = win.tabs?.find((tab) => tab.active && buildPrefillFromTab(tab));
    if (activeTab) {
      return activeTab;
    }
  }

  for (const win of ordered) {
    const browsable = win.tabs?.find((tab) => buildPrefillFromTab(tab));
    if (browsable) {
      return browsable;
    }
  }

  const tabs = await browser.tabs.query({ url: ["http://*/*", "https://*/*"] });
  if (tabs.length === 0) {
    return null;
  }

  return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

export async function getBrowsingTabPrefill() {
  return buildPrefillFromTab(await findBrowsingTab());
}

export async function consumeBuilderPrefill() {
  const key = globalThis.SnLinksStorageKeys.LINK_BUILDER_PREFILL_KEY;
  const stored = await browser.storage.session.get(key);
  if (Object.prototype.hasOwnProperty.call(stored, key)) {
    const prefill = stored[key];
    await browser.storage.session.remove(key);
    if (prefill) {
      return prefill;
    }
  }
  return getBrowsingTabPrefill();
}

export async function getTabPrefill() {
  return getBrowsingTabPrefill();
}

export function getBuilderFormElements(root = document) {
  return {
    editIdInput: root.getElementById("link-edit-id"),
    sectionSelect: root.getElementById("link-section"),
    sectionNewInput: root.getElementById("link-section-new"),
    sectionNewField: root.getElementById("link-section-new-field"),
    typeSelect: root.getElementById("link-type"),
    nameInput: root.getElementById("link-name"),
    displayNameInput: root.getElementById("link-display-name"),
    codeInput: root.getElementById("link-code"),
    pathInput: root.getElementById("link-path"),
    urlInput: root.getElementById("link-url"),
    navSelect: root.getElementById("link-nav"),
    searchTagsInput: root.getElementById("link-search-tags"),
    codeField: root.getElementById("link-code-field"),
    pathField: root.getElementById("link-path-field"),
    urlField: root.getElementById("link-url-field"),
    navField: root.getElementById("link-nav-field"),
    hostPatternField: root.getElementById("host-pattern-field"),
    searchTagsField: root.getElementById("search-tags-field"),
    fieldElements: getBuilderFieldElements(root),
  };
}

function parseSearchTags(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  const tags = trimmed
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.length ? tags : undefined;
}

function setNavOptions(navSelect, type, selectedValue) {
  const options = NAV_OPTIONS[type] || NAV_OPTIONS.navigate;
  const current = selectedValue ?? navSelect.value;
  navSelect.replaceChildren();
  for (const option of options) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    navSelect.appendChild(el);
  }
  const allowed = options.some((option) => option.value === current);
  navSelect.value = allowed ? current : options[0]?.value || "";
}

export function buildLinkNodeFromForm(form) {
  const type = form.type;
  const name = form.name.trim();
  if (!name) {
    throw new Error("Name is required.");
  }

  const node = { name };
  if (form.editId) {
    node.id = form.editId;
  }
  if (form.displayName.trim()) {
    node.displayName = form.displayName.trim();
  }

  if (form.hostPattern !== undefined) {
    node.hostPattern = form.hostPattern;
  }

  const searchTags = parseSearchTags(form.searchTags);
  if (searchTags) {
    node.searchTags = searchTags;
  }

  if (type === "scriptlet") {
    node.type = "scriptlet";
    const code = normalizeScriptInput(form.code);
    if (!code) {
      throw new Error("Script code is required.");
    }
    node.code = code;
    if (form.nav.trim()) {
      node.nav = form.nav.trim();
    }
  } else if (type === "navigate") {
    node.type = "navigate";
    const path = form.path.trim();
    if (!path) {
      throw new Error("Path is required.");
    }
    node.path = path;
    if (form.nav.trim()) {
      node.nav = form.nav.trim();
    }
  } else if (type === "derived-url") {
    node.type = "derived-url";
    const nav = form.nav.trim();
    if (!nav) {
      throw new Error("Navigation mode is required for derived URLs.");
    }
    node.nav = nav;
    const path = form.path.trim();
    const url = form.url.trim();
    if (!path && !url) {
      throw new Error("Path or URL template is required.");
    }
    if (path) {
      node.path = path;
    }
    if (url) {
      node.url = url;
    }
    if (form.extract) {
      node.extract = form.extract;
    }
  } else {
    throw new Error(`Unknown link type: ${type}`);
  }

  if (form.parameter) {
    node.parameter = form.parameter;
  }
  if (form.parameters) {
    node.parameters = form.parameters;
  }

  return form.editId ? node : ensureLinkId(node);
}

export function readTargetSection(elements) {
  const selected = elements.sectionSelect?.value || "";
  if (selected === "__new__") {
    const name = elements.sectionNewInput?.value.trim() || "";
    if (!name) {
      throw new Error("New section name is required.");
    }
    return name;
  }
  if (!selected) {
    throw new Error("Section is required.");
  }
  return selected;
}

export function populateSectionSelect(elements, sectionNames, selectedSection) {
  if (!elements.sectionSelect) {
    return;
  }

  elements.sectionSelect.replaceChildren();
  for (const name of sectionNames) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    elements.sectionSelect.appendChild(option);
  }

  const newOption = document.createElement("option");
  newOption.value = "__new__";
  newOption.textContent = "Create new section…";
  elements.sectionSelect.appendChild(newOption);

  const hasSelected =
    selectedSection && sectionNames.includes(selectedSection);
  if (hasSelected) {
    elements.sectionSelect.value = selectedSection;
    elements.sectionNewInput.value = "";
    setFieldVisible(elements.sectionNewField, false);
    return;
  }

  if (selectedSection) {
    elements.sectionSelect.value = "__new__";
    elements.sectionNewInput.value = selectedSection;
    setFieldVisible(elements.sectionNewField, true);
    return;
  }

  elements.sectionSelect.value = sectionNames[0] || "__new__";
  elements.sectionNewInput.value = "";
  setFieldVisible(elements.sectionNewField, elements.sectionSelect.value === "__new__");
}

export function readBuilderForm(elements) {
  const parameterFields = readParameterFields(elements.fieldElements);
  const extract = readExtractFields(elements.fieldElements);
  const hostPattern = readHostPattern(elements.fieldElements);

  return {
    editId: elements.editIdInput.value.trim() || null,
    sectionName: readTargetSection(elements),
    type: elements.typeSelect.value,
    name: elements.nameInput.value,
    displayName: elements.displayNameInput.value,
    hostPattern,
    searchTags: elements.searchTagsInput.value,
    code: getFieldValue(elements.codeInput),
    path: elements.pathInput.value,
    url: elements.urlInput.value,
    nav: elements.navSelect.value,
    extract,
    ...parameterFields,
  };
}

export function populateBuilderForm(elements, node, sectionName, sectionNames) {
  elements.editIdInput.value = node.id || "";
  populateSectionSelect(elements, sectionNames, sectionName);
  elements.typeSelect.value = node.type || "scriptlet";
  elements.nameInput.value = node.name || "";
  elements.displayNameInput.value = node.displayName || "";
  populateHostPattern(elements.fieldElements, node.hostPattern);
  elements.searchTagsInput.value = Array.isArray(node.searchTags)
    ? node.searchTags.join(", ")
    : "";
  setFieldValue(elements.codeInput, node.code || "");
  elements.pathInput.value = node.path || "";
  elements.urlInput.value = node.url || "";
  populateParameterFields(elements.fieldElements, node);
  populateExtractFields(elements.fieldElements, node.extract);
  setNavOptions(elements.navSelect, elements.typeSelect.value, node.nav || "");
  updateBuilderFieldVisibility(elements);
}

export function clearBuilderForm(elements, sectionNames, defaultSection) {
  elements.editIdInput.value = "";
  populateSectionSelect(elements, sectionNames, defaultSection);
  elements.typeSelect.value = "scriptlet";
  elements.nameInput.value = "";
  elements.displayNameInput.value = "";
  populateHostPattern(elements.fieldElements, undefined);
  elements.searchTagsInput.value = "";
  setFieldValue(elements.codeInput, "");
  elements.pathInput.value = "";
  elements.urlInput.value = "";
  clearParameterFields(elements.fieldElements);
  clearExtractFields(elements.fieldElements);
  setNavOptions(elements.navSelect, "scriptlet", "");
  updateBuilderFieldVisibility(elements);
}

export function applyTabPrefill(elements, prefill, type = "navigate") {
  if (!prefill) {
    return;
  }
  elements.typeSelect.value = type;
  elements.nameInput.value = prefill.name || "";
  elements.displayNameInput.value = prefill.displayName || prefill.name || "";
  elements.pathInput.value = prefill.path || "";

  if (prefill.hostPattern) {
    populateHostPattern(elements.fieldElements, prefill.hostPattern);
  }

  if (type === "navigate" || type === "derived-url") {
    if (prefill.parameters) {
      populateParameterFields(elements.fieldElements, { parameters: prefill.parameters });
    } else if (prefill.parameter) {
      populateParameterFields(elements.fieldElements, { parameter: prefill.parameter });
    } else {
      clearParameterFields(elements.fieldElements);
    }
  }

  const defaultNav =
    type === "derived-url"
      ? "foreground"
      : /^https?:\/\//i.test(prefill.absoluteUrl || prefill.path || "")
        ? "foreground"
        : "same-tab";
  setNavOptions(elements.navSelect, type, defaultNav);
  updateBuilderFieldVisibility(elements);
}

function applyPrefillIfEmpty(elements, prefill, type) {
  if (!prefill || (type !== "navigate" && type !== "derived-url")) {
    return;
  }

  if (!elements.nameInput.value.trim()) {
    elements.nameInput.value = prefill.name || "";
  }
  if (!elements.displayNameInput.value.trim()) {
    elements.displayNameInput.value = prefill.displayName || prefill.name || "";
  }
  if (!elements.pathInput.value.trim()) {
    elements.pathInput.value = prefill.path || "";
  }

  if (
    prefill.hostPattern &&
    elements.fieldElements.hostPatternModeSelect.value === "inherit"
  ) {
    populateHostPattern(elements.fieldElements, prefill.hostPattern);
  }

  if (elements.fieldElements.parameterModeSelect.value === "none") {
    if (prefill.parameters) {
      populateParameterFields(elements.fieldElements, { parameters: prefill.parameters });
    } else if (prefill.parameter) {
      populateParameterFields(elements.fieldElements, { parameter: prefill.parameter });
    }
  }
}

export function updateBuilderFieldVisibility(elements) {
  const type = elements.typeSelect.value;
  const isScriptlet = type === "scriptlet";
  const isNavigate = type === "navigate";
  const isDerived = type === "derived-url";

  setFieldVisible(elements.codeField, isScriptlet);
  setFieldVisible(elements.pathField, isNavigate || isDerived);
  setFieldVisible(elements.urlField, isDerived);
  setFieldVisible(elements.navField, isNavigate || isDerived);
  setFieldVisible(elements.fieldElements.extractSection, isDerived);

  if (isNavigate || isDerived) {
    setNavOptions(
      elements.navSelect,
      type,
      isNavigate && !elements.navSelect.value ? "same-tab" : elements.navSelect.value
    );
    elements.navSelect.required = isDerived;
  } else {
    elements.navSelect.required = false;
  }

  updateHostPatternFieldVisibility(elements.fieldElements);
  updateParameterModeVisibility(elements.fieldElements);
}

export function initBuilderForm(elements, { sectionNames = [], defaultSection } = {}) {
  wireBuilderFieldUi(elements.fieldElements);
  populateSectionSelect(elements, sectionNames, defaultSection);

  elements.sectionSelect?.addEventListener("change", () => {
    setFieldVisible(
      elements.sectionNewField,
      elements.sectionSelect.value === "__new__"
    );
  });

  elements.typeSelect.addEventListener("change", async () => {
    const type = elements.typeSelect.value;
    if (type === "navigate" || type === "derived-url") {
      applyPrefillIfEmpty(elements, await getBrowsingTabPrefill(), type);
    }
    updateBuilderFieldVisibility(elements);
  });

  updateBuilderFieldVisibility(elements);
}
