import {
  wireBuilderFieldUi,
  updateHostPatternFieldVisibility,
  updateParameterModeVisibility,
  readHostPattern,
  populateHostPattern,
  readParameterFields,
  populateParameterFields,
  clearParameterFields,
  populateNavParamsFields,
  readNavParamsFields,
  clearNavParamsFields,
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
    { value: "tab", label: "New tab (foreground)" },
    { value: "background", label: "New tab (background)" },
    { value: "download", label: "Download" },
  ],
  navigate: [
    { value: "same-tab", label: "Same tab" },
    { value: "tab", label: "New tab (foreground)" },
    { value: "background", label: "New tab (background)" },
    { value: "download", label: "Download" },
  ],
  "derived-url": [
    { value: "same-tab", label: "Same tab" },
    { value: "tab", label: "New tab (foreground)" },
    { value: "background", label: "New tab (background)" },
    { value: "download", label: "Download" },
  ],
};

function paramsFromFormFields(parameterFields) {
  if (parameterFields.params) {
    return parameterFields.params;
  }
  if (parameterFields.parameters) {
    return parameterFields.parameters;
  }
  if (parameterFields.parameter) {
    const { name, ...rest } = parameterFields.parameter;
    return { [name || "value"]: rest };
  }
  return undefined;
}

function inferBuilderType(node) {
  if (node.code) {
    return "scriptlet";
  }
  if (node.navParams || node.extract || (node.url && /\{[^}]+\}/.test(node.url))) {
    return "derived-url";
  }
  return "navigate";
}

function openForBuilderSelect(node) {
  const open = node.open ?? node.nav;
  if (open === "foreground") return "tab";
  if (open === "fetch") return "download";
  return open || "";
}

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
      url: input,
      open: input.startsWith("/") ? "same-tab" : "tab",
    };
    return ensureLinkId(node);
  }

  const code = normalizeScriptInput(input);
  const scriptlets = existingNodes.filter((node) => node.code && !node.url);
  return ensureLinkId({
    name: nameInput.trim() || defaultScriptName(code, scriptlets),
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
        url: urlString,
      };
    }

    const paramEntries = [...new URLSearchParams(url.search).entries()];
    const pathname = url.pathname || "/";
    const hash = url.hash || "";

    if (paramEntries.length === 0) {
      return {
        url: `${pathname}${hash}`,
      };
    }

    const params = {};
    const queryParts = [];
    for (const [name, value] of paramEntries) {
      queryParts.push(`${encodeURIComponent(name)}={${name}}`);
      params[name] = { default: value, placeholder: name };
    }

    const urlTemplate = `${pathname}?${queryParts.join("&")}${hash}`;
    return { url: urlTemplate, params };
  } catch {
    return {
      url: pathFromTabUrl(urlString),
    };
  }
}

export function buildPrefillFromTab(tab) {
  if (!tab?.url || !/^https?:\/\//i.test(tab.url)) {
    return null;
  }

  const { url, params } = buildPathTemplateFromUrl(tab.url);
  const title = tab.title?.trim() || defaultUrlName(url, 0);
  return {
    name: title,
    displayName: title,
    url,
    params,
    match: hostPatternFromUrl(tab.url),
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

  const draft = { name };
  if (form.editId) {
    draft.id = form.editId;
  }
  if (form.displayName.trim()) {
    draft.displayName = form.displayName.trim();
  }

  if (form.match !== undefined) {
    draft.match = form.match;
  }

  const searchTags = parseSearchTags(form.searchTags);
  if (searchTags) {
    draft.searchTags = searchTags;
  }

  const params = paramsFromFormFields(form);

  if (type === "scriptlet") {
    if (params) {
      draft.params = params;
    }
    const code = normalizeScriptInput(form.code);
    if (!code) {
      throw new Error("Script code is required.");
    }
    draft.code = code;
    if (form.nav.trim()) {
      draft.open = form.nav.trim();
    }
  } else if (type === "navigate") {
    const url = form.url.trim() || form.path.trim();
    if (!url) {
      throw new Error("URL is required.");
    }
    draft.url = url;
    draft.open = form.nav.trim() || "same-tab";
    if (form.navParams) {
      draft.navParams = form.navParams;
    }
  } else if (type === "derived-url") {
    const open = form.nav.trim();
    if (!open) {
      throw new Error("Open mode is required for derived URLs.");
    }
    draft.open = open;
    const url = form.url.trim() || form.path.trim();
    if (!url) {
      throw new Error("URL template is required.");
    }
    draft.url = url;
    if (form.navParams) {
      draft.navParams = form.navParams;
    }
  } else {
    throw new Error(`Unknown link type: ${type}`);
  }

  const node = globalThis.SnLinksLinkModel.normalizeLeafNode(draft);
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
  const navParams = readNavParamsFields(elements.fieldElements);
  const match = readHostPattern(elements.fieldElements);

  return {
    editId: elements.editIdInput.value.trim() || null,
    sectionName: readTargetSection(elements),
    type: elements.typeSelect.value,
    name: elements.nameInput.value,
    displayName: elements.displayNameInput.value,
    match,
    searchTags: elements.searchTagsInput.value,
    code: getFieldValue(elements.codeInput),
    path: elements.pathInput.value,
    url: elements.urlInput.value,
    nav: elements.navSelect.value,
    navParams,
    ...parameterFields,
  };
}

export function populateBuilderForm(elements, node, sectionName, sectionNames) {
  const normalized = globalThis.SnLinksLinkModel.normalizeLeafNode(node);
  elements.editIdInput.value = normalized.id || "";
  populateSectionSelect(elements, sectionNames, sectionName);
  elements.typeSelect.value = inferBuilderType(normalized);
  elements.nameInput.value = normalized.name || "";
  elements.displayNameInput.value = normalized.displayName || "";
  populateHostPattern(elements.fieldElements, normalized.match);
  elements.searchTagsInput.value = Array.isArray(normalized.searchTags)
    ? normalized.searchTags.join(", ")
    : "";
  setFieldValue(elements.codeInput, normalized.code || "");
  elements.pathInput.value = "";
  elements.urlInput.value = normalized.url || "";
  populateParameterFields(elements.fieldElements, normalized);
  populateNavParamsFields(elements.fieldElements, normalized.navParams);
  setNavOptions(
    elements.navSelect,
    elements.typeSelect.value,
    openForBuilderSelect(normalized)
  );
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
  clearNavParamsFields(elements.fieldElements);
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
  elements.urlInput.value = prefill.url || prefill.path || "";
  elements.pathInput.value = "";

  if (prefill.match) {
    populateHostPattern(elements.fieldElements, prefill.match);
  }

  if (type === "navigate" || type === "derived-url") {
    clearParameterFields(elements.fieldElements);
    if (prefill.navParams) {
      populateNavParamsFields(elements.fieldElements, prefill.navParams);
    } else if (prefill.params || prefill.parameters || prefill.parameter) {
      // Legacy prefill: URL params → navParams via normalize.
      const normalized = globalThis.SnLinksLinkModel.normalizeLeafNode({
        name: prefill.name || "prefill",
        url: prefill.url || prefill.path || "/",
        open: "tab",
        ...(prefill.params ? { params: prefill.params } : {}),
        ...(prefill.parameters ? { parameters: prefill.parameters } : {}),
        ...(prefill.parameter ? { parameter: prefill.parameter } : {}),
      });
      populateNavParamsFields(elements.fieldElements, normalized.navParams);
    } else {
      clearNavParamsFields(elements.fieldElements);
    }
  }

  const defaultOpen =
    type === "derived-url"
      ? "tab"
      : /^https?:\/\//i.test(prefill.absoluteUrl || prefill.url || prefill.path || "")
        ? "tab"
        : "same-tab";
  setNavOptions(elements.navSelect, type, defaultOpen);
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
  if (!elements.urlInput.value.trim()) {
    elements.urlInput.value = prefill.url || prefill.path || "";
  }

  if (
    prefill.match &&
    elements.fieldElements.hostPatternModeSelect.value === "inherit"
  ) {
    populateHostPattern(elements.fieldElements, prefill.match);
  }
}

export function updateBuilderFieldVisibility(elements) {
  const type = elements.typeSelect.value;
  const isScriptlet = type === "scriptlet";
  const isNavigate = type === "navigate";
  const isDerived = type === "derived-url";
  const isUrlType = isNavigate || isDerived;

  setFieldVisible(elements.codeField, isScriptlet);
  setFieldVisible(elements.pathField, false);
  setFieldVisible(elements.urlField, isUrlType);
  setFieldVisible(elements.navField, isUrlType);
  setFieldVisible(elements.fieldElements.parametersSection, isScriptlet);
  setFieldVisible(elements.fieldElements.navParamsSection, isUrlType);

  if (isUrlType) {
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
