import {
  attachCodeMirrorAll,
  getFieldValue,
  setFieldValue,
} from "../lib/codemirror-fields.bundle.js";

const rulesListEl = document.getElementById("rules-list");
const rulesLogEl = document.getElementById("rules-log");
const ruleCountEl = document.getElementById("rule-count");
const messageEl = document.getElementById("message");
const rulesEnabledEl = document.getElementById("rules-enabled");
const ruleFormEl = document.getElementById("rule-form");
const editorTitleEl = document.getElementById("editor-title");

const ruleNameEl = document.getElementById("rule-name");
const rulePriorityEl = document.getElementById("rule-priority");
const ruleEnabledEl = document.getElementById("rule-enabled");
const ruleHostPatternEl = document.getElementById("rule-host-pattern");
const rulePageHostPatternEl = document.getElementById("rule-page-host-pattern");
const rulePageUrlPatternEl = document.getElementById("rule-page-url-pattern");
const ruleRequestUrlPatternEl = document.getElementById("rule-request-url-pattern");
const ruleBodyPatternEl = document.getElementById("rule-body-pattern");
const ruleContentTypePatternEl = document.getElementById("rule-content-type-pattern");
const ruleMethodsEl = document.getElementById("rule-methods");
const ruleResourceTypesEl = document.getElementById("rule-resource-types");
const phaseRequestEl = document.getElementById("phase-request");
const phaseResponseEl = document.getElementById("phase-response");
const ruleStatusMinEl = document.getElementById("rule-status-min");
const ruleStatusMaxEl = document.getElementById("rule-status-max");
const ruleActionEl = document.getElementById("rule-action");
const ruleRedirectUrlEl = document.getElementById("rule-redirect-url");
const ruleServeWithoutRequestEl = document.getElementById("rule-serve-without-request");
const ruleMockStatusEl = document.getElementById("rule-mock-status");
const ruleMockStatusTextEl = document.getElementById("rule-mock-status-text");
const ruleMockBodyEl = document.getElementById("rule-mock-body");
const urlReplacementsEl = document.getElementById("url-replacements");
const bodyReplacementsEl = document.getElementById("body-replacements");
const headerReplacementsEl = document.getElementById("header-replacements");
const setHeadersEl = document.getElementById("set-headers");
const ruleRequestScriptEl = document.getElementById("rule-request-script");
const ruleResponseScriptEl = document.getElementById("rule-response-script");
const deleteRuleBtn = document.getElementById("delete-rule-btn");
const ruleTemplateSelectEl = document.getElementById("rule-template-select");

attachCodeMirrorAll({
  hostPattern: { element: ruleHostPatternEl, language: "regex", compact: true },
  pageHostPattern: {
    element: rulePageHostPatternEl,
    language: "regex",
    compact: true,
  },
  pageUrlPattern: {
    element: rulePageUrlPatternEl,
    language: "regex",
    compact: true,
  },
  requestUrlPattern: {
    element: ruleRequestUrlPatternEl,
    language: "regex",
    compact: true,
  },
  bodyPattern: { element: ruleBodyPatternEl, language: "regex", compact: true },
  contentTypePattern: {
    element: ruleContentTypePatternEl,
    language: "regex",
    compact: true,
  },
  mockBody: {
    element: ruleMockBodyEl,
    language: "json",
    minHeight: 96,
    placeholder: '{"result":[]}',
  },
  requestScript: {
    element: ruleRequestScriptEl,
    language: "javascript",
    minHeight: 120,
    placeholder:
      "function(ctx, rule) { console.log(ctx.url, ctx.body); return ctx; }",
  },
  responseScript: {
    element: ruleResponseScriptEl,
    language: "javascript",
    minHeight: 120,
    placeholder: "function(ctx, rule) { return ctx; }",
  },
});

let rulesState = defaultNetworkRulesState();
let selectedRuleId = null;
let highlightedRuleId = null;
let ruleTemplates = [];
let lastPersistedRulesSnapshot = "";

const { showMessage, hideMessage } = createUiMessage(messageEl);

function summarizeRule(rule) {
  const filters = [];
  if (rule.hostPattern) filters.push("host");
  if (rule.pageHostPattern) filters.push("pageHost");
  if (rule.pageUrlPattern) filters.push("page");
  if (rule.requestUrlPattern) filters.push("url");
  if (rule.requestBodyPattern) filters.push("body");
  if (rule.methods?.length) filters.push(rule.methods.join(","));
  if (rule.resourceTypes?.length) filters.push(rule.resourceTypes.join(","));
  return `${rule.action}${filters.length ? ` · ${filters.join(" · ")}` : ""}`;
}

function renderMethodChecks(selectedMethods) {
  ruleMethodsEl.replaceChildren();
  const selected = new Set((selectedMethods || []).map((method) => method.toUpperCase()));

  for (const method of HTTP_METHODS) {
    const label = document.createElement("label");
    label.className = "inline-check";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = method;
    input.checked = selected.has(method);

    const text = document.createElement("span");
    text.textContent = method;

    label.appendChild(input);
    label.appendChild(text);
    ruleMethodsEl.appendChild(label);
  }
}

function readSelectedMethods() {
  return [...ruleMethodsEl.querySelectorAll('input[type="checkbox"]:checked')].map(
    (input) => input.value
  );
}

function renderResourceTypeChecks(selectedTypes) {
  ruleResourceTypesEl.replaceChildren();
  const selected = new Set(selectedTypes || []);

  for (const type of WEBREQUEST_RESOURCE_TYPES) {
    const label = document.createElement("label");
    label.className = "inline-check";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = type;
    input.checked = selected.has(type);

    const text = document.createElement("span");
    text.textContent = type;

    label.appendChild(input);
    label.appendChild(text);
    ruleResourceTypesEl.appendChild(label);
  }
}

function readSelectedResourceTypes() {
  return [
    ...ruleResourceTypesEl.querySelectorAll('input[type="checkbox"]:checked'),
  ].map((input) => input.value);
}

function createReplacementRow(replacement, options = {}) {
  const row = document.createElement("div");
  row.className = "replacement-row";
  if (options.header) {
    row.classList.add("header-row");
  }

  if (options.header) {
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.placeholder = "Header";
    nameInput.value = replacement.name || "";
    nameInput.dataset.field = "name";
    row.appendChild(nameInput);
  }

  const findInput = document.createElement("input");
  findInput.type = "text";
  findInput.placeholder = "Find";
  findInput.value = replacement.find || "";
  findInput.dataset.field = "find";
  row.appendChild(findInput);

  const replaceInput = document.createElement("input");
  replaceInput.type = "text";
  replaceInput.placeholder = "Replace";
  replaceInput.value = replacement.replace || "";
  replaceInput.dataset.field = "replace";
  row.appendChild(replaceInput);

  const regexLabel = document.createElement("label");
  regexLabel.className = "inline-check";
  const regexInput = document.createElement("input");
  regexInput.type = "checkbox";
  regexInput.checked = Boolean(replacement.isRegex);
  regexInput.dataset.field = "isRegex";
  regexLabel.appendChild(regexInput);
  regexLabel.appendChild(document.createTextNode("regex"));
  row.appendChild(regexLabel);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "secondary icon-btn";
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", () => row.remove());
  row.appendChild(removeBtn);

  return row;
}

function createSetHeaderRow(header) {
  const row = document.createElement("div");
  row.className = "set-header-row";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "Header name";
  nameInput.value = header.name || "";
  nameInput.dataset.field = "name";

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.placeholder = "Value";
  valueInput.value = header.value || "";
  valueInput.dataset.field = "value";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "secondary icon-btn";
  removeBtn.textContent = "×";
  removeBtn.addEventListener("click", () => row.remove());

  row.appendChild(nameInput);
  row.appendChild(valueInput);
  row.appendChild(removeBtn);
  return row;
}

function renderReplacementList(container, replacements, { header = false } = {}) {
  container.replaceChildren();
  for (const replacement of replacements || []) {
    container.appendChild(createReplacementRow(replacement, { header }));
  }
}

function renderSetHeaders(container, headers) {
  container.replaceChildren();
  for (const header of headers || []) {
    container.appendChild(createSetHeaderRow(header));
  }
}

function readReplacementList(container, { header = false } = {}) {
  return [...container.querySelectorAll(".replacement-row")].map((row) => {
    const item = {
      find: row.querySelector('[data-field="find"]')?.value ?? "",
      replace: row.querySelector('[data-field="replace"]')?.value ?? "",
      isRegex: row.querySelector('[data-field="isRegex"]')?.checked ?? false,
    };
    if (header) {
      item.name = row.querySelector('[data-field="name"]')?.value ?? "";
    }
    return item;
  });
}

function readSetHeaders(container) {
  return [...container.querySelectorAll(".set-header-row")].map((row) => ({
    name: row.querySelector('[data-field="name"]')?.value ?? "",
    value: row.querySelector('[data-field="value"]')?.value ?? "",
  }));
}

function updateActionSections() {
  const action = ruleActionEl.value;
  document.querySelector(".action-redirect").classList.toggle(
    "hidden",
    action !== "redirect"
  );
  document.querySelector(".action-modify").classList.toggle(
    "hidden",
    action !== "modify"
  );
  document.querySelectorAll(".action-mock-fields").forEach((el) => {
    el.classList.toggle("hidden", action !== "mock" && action !== "modify");
  });
  document.querySelector(".action-mock").classList.toggle(
    "hidden",
    action !== "modify"
  );
  if (ruleServeWithoutRequestEl) {
    ruleServeWithoutRequestEl.disabled = action !== "modify";
  }
}

function getSelectedRule() {
  return rulesState.rules.find((rule) => rule.id === selectedRuleId) || null;
}

function loadRuleIntoForm(rule) {
  if (!rule) {
    ruleFormEl.classList.add("hidden");
    editorTitleEl.textContent = "Rule editor";
    deleteRuleBtn.disabled = true;
    return;
  }

  ruleFormEl.classList.remove("hidden");
  deleteRuleBtn.disabled = false;
  editorTitleEl.textContent = rule.name || "Rule editor";

  ruleNameEl.value = rule.name || "";
  rulePriorityEl.value = String(rule.priority ?? 100);
  ruleEnabledEl.checked = Boolean(rule.enabled);
  setFieldValue(ruleHostPatternEl, rule.hostPattern || "");
  setFieldValue(rulePageHostPatternEl, rule.pageHostPattern || "");
  setFieldValue(rulePageUrlPatternEl, rule.pageUrlPattern || "");
  setFieldValue(ruleRequestUrlPatternEl, rule.requestUrlPattern || "");
  setFieldValue(ruleBodyPatternEl, rule.requestBodyPattern || "");
  setFieldValue(ruleContentTypePatternEl, rule.requestContentTypePattern || "");
  renderMethodChecks(rule.methods);
  renderResourceTypeChecks(rule.resourceTypes);
  phaseRequestEl.checked = (rule.phases || ["request"]).includes("request");
  phaseResponseEl.checked = (rule.phases || []).includes("response");
  ruleStatusMinEl.value =
    rule.responseStatusMin != null ? String(rule.responseStatusMin) : "";
  ruleStatusMaxEl.value =
    rule.responseStatusMax != null ? String(rule.responseStatusMax) : "";
  ruleActionEl.value = rule.action || "modify";
  ruleRedirectUrlEl.value = rule.redirectUrl || "";
  ruleServeWithoutRequestEl.checked = Boolean(rule.modify?.serveWithoutRequest);
  ruleMockStatusEl.value = String(rule.modify?.mockStatus ?? 200);
  ruleMockStatusTextEl.value = rule.modify?.mockStatusText || "OK";
  setFieldValue(ruleMockBodyEl, rule.modify?.mockBody || "");
  renderReplacementList(urlReplacementsEl, rule.modify?.urlReplacements);
  renderReplacementList(bodyReplacementsEl, rule.modify?.bodyReplacements);
  renderReplacementList(headerReplacementsEl, rule.modify?.headerReplacements, {
    header: true,
  });
  renderSetHeaders(setHeadersEl, rule.modify?.setHeaders);
  setFieldValue(ruleRequestScriptEl, rule.modify?.requestScript || "");
  setFieldValue(ruleResponseScriptEl, rule.modify?.responseScript || "");
  updateActionSections();
}

function createRuleDeleteButton(rule) {
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "rule-item-delete";
  deleteBtn.title = "Delete rule";
  deleteBtn.setAttribute("aria-label", `Delete ${rule.name || "rule"}`);
  deleteBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6 1h4l1 1h3v2H2V2h3l1-1zM3 5h10l-1 9H4L3 5zm3 2v5h1V7H6zm3 0v5h1V7H9z"/></svg>';
  deleteBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteRuleById(rule.id);
  });
  return deleteBtn;
}

function renderRulesList() {
  rulesListEl.replaceChildren();
  ruleCountEl.textContent = `${rulesState.rules.length} rule${
    rulesState.rules.length === 1 ? "" : "s"
  }`;

  if (rulesState.rules.length === 0) {
    const empty = document.createElement("p");
    empty.className = "log-empty";
    empty.style.padding = "12px";
    empty.textContent = "No rules yet.";
    rulesListEl.appendChild(empty);
    selectedRuleId = null;
    loadRuleIntoForm(null);
    return;
  }

  const sorted = [...rulesState.rules].sort(
    (a, b) => (a.priority ?? 100) - (b.priority ?? 100)
  );

  if (selectedRuleId && !sorted.some((rule) => rule.id === selectedRuleId)) {
    selectedRuleId = sorted[0]?.id || null;
  }

  for (const rule of sorted) {
    const row = document.createElement("div");
    row.className = "rule-item-row";
    if (rule.id === highlightedRuleId) {
      row.classList.add("matched");
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "rule-item";
    if (!rule.enabled) {
      button.classList.add("disabled");
    }
    if (rule.id === selectedRuleId) {
      button.classList.add("active");
    }

    const title = document.createElement("span");
    title.className = "rule-item-title";
    title.textContent = rule.name || "Untitled rule";

    const meta = document.createElement("span");
    meta.className = "rule-item-meta";
    meta.textContent = summarizeRule(rule);

    button.appendChild(title);
    button.appendChild(meta);
    button.addEventListener("click", () => {
      selectedRuleId = rule.id;
      renderRulesList();
      loadRuleIntoForm(rule);
    });

    row.appendChild(button);
    row.appendChild(createRuleDeleteButton(rule));
    rulesListEl.appendChild(row);
  }

  if (!selectedRuleId && sorted.length) {
    selectedRuleId = sorted[0].id;
    loadRuleIntoForm(sorted[0]);
    renderRulesList();
  }
}

function renderLog(entries) {
  rulesLogEl.replaceChildren();
  if (!entries?.length) {
    const empty = document.createElement("p");
    empty.className = "log-empty";
    empty.textContent = "No matches yet.";
    rulesLogEl.appendChild(empty);
    return;
  }

  const newest = entries[entries.length - 1];
  if (newest?.ruleId) {
    highlightedRuleId = newest.ruleId;
    renderRulesList();
  }

  for (const entry of [...entries].reverse()) {
    const line = document.createElement("div");
    line.className = "log-entry";
    if (entry.ruleId && entry.ruleId === highlightedRuleId) {
      line.classList.add("log-entry-recent");
    }
    if (entry.ruleId && entry.ruleId === selectedRuleId) {
      line.classList.add("log-entry-selected");
    }
    const time = new Date(entry.ts || Date.now()).toLocaleTimeString();
    const detail = entry.detail ? ` · ${entry.detail}` : "";
    line.textContent = `[${time}] ${entry.ruleName || entry.ruleId || "rule"} · ${
      entry.outcome
    } · ${entry.method || "?"} ${entry.url || ""}${
      entry.resourceType ? ` · ${entry.resourceType}` : ""
    }${entry.via ? ` · ${entry.via}` : ""}${detail}`;
    rulesLogEl.appendChild(line);
  }
}

async function persistRulesState() {
  const response = await browser.runtime.sendMessage({
    type: "SAVE_NETWORK_RULES",
    state: rulesState,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Save failed.");
  }
  lastPersistedRulesSnapshot = JSON.stringify(rulesState);
}

async function deleteRuleById(ruleId) {
  hideMessage();
  const existing = rulesState.rules.find((rule) => rule.id === ruleId);
  if (!existing) {
    return;
  }

  rulesState.rules = rulesState.rules.filter((rule) => rule.id !== ruleId);
  if (selectedRuleId === ruleId) {
    const sorted = [...rulesState.rules].sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100)
    );
    selectedRuleId = sorted[0]?.id || null;
  }

  renderRulesList();
  loadRuleIntoForm(getSelectedRule());

  try {
    await persistRulesState();
    showMessage(`Deleted "${existing.name}".`);
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

async function insertRuleFromTemplate(templateId) {
  if (!templateId) {
    return;
  }

  const template = ruleTemplates.find((item) => item.id === templateId);
  if (!template) {
    showMessage("Unknown template.");
    return;
  }

  hideMessage();
  try {
    const rule = instantiateNetworkRuleTemplate(template);
    rulesState.rules.push(rule);
    selectedRuleId = rule.id;
    renderRulesList();
    loadRuleIntoForm(rule);
    await persistRulesState();
    showMessage(`Added "${rule.name}" from template.`);
  } catch (error) {
    showMessage(error.message || String(error));
  } finally {
    if (ruleTemplateSelectEl) {
      ruleTemplateSelectEl.value = "";
    }
  }
}

function readRuleFromForm(existingRule) {
  const phases = [];
  if (phaseRequestEl.checked) phases.push("request");
  if (phaseResponseEl.checked) phases.push("response");
  if (!phases.length) {
    throw new Error("Select at least one phase.");
  }

  const statusMinRaw = ruleStatusMinEl.value.trim();
  const statusMaxRaw = ruleStatusMaxEl.value.trim();

  return {
    ...existingRule,
    name: ruleNameEl.value.trim() || "Untitled rule",
    enabled: ruleEnabledEl.checked,
    priority: Number(rulePriorityEl.value) || 100,
    hostPattern: getFieldValue(ruleHostPatternEl).trim(),
    pageHostPattern: getFieldValue(rulePageHostPatternEl).trim(),
    pageUrlPattern: getFieldValue(rulePageUrlPatternEl).trim(),
    requestUrlPattern: getFieldValue(ruleRequestUrlPatternEl).trim(),
    requestBodyPattern: getFieldValue(ruleBodyPatternEl).trim(),
    requestContentTypePattern: getFieldValue(ruleContentTypePatternEl).trim(),
    methods: readSelectedMethods(),
    resourceTypes: readSelectedResourceTypes(),
    phases,
    responseStatusMin: statusMinRaw ? Number(statusMinRaw) : null,
    responseStatusMax: statusMaxRaw ? Number(statusMaxRaw) : null,
    action: ruleActionEl.value,
    redirectUrl: ruleRedirectUrlEl.value.trim(),
    modify: {
      urlReplacements: readReplacementList(urlReplacementsEl),
      bodyReplacements: readReplacementList(bodyReplacementsEl),
      headerReplacements: readReplacementList(headerReplacementsEl, {
        header: true,
      }),
      setHeaders: readSetHeaders(setHeadersEl),
      requestScript: getFieldValue(ruleRequestScriptEl),
      responseScript: getFieldValue(ruleResponseScriptEl),
      serveWithoutRequest: ruleServeWithoutRequestEl.checked,
      mockStatus: Number(ruleMockStatusEl.value) || 200,
      mockStatusText: ruleMockStatusTextEl.value.trim() || "OK",
      mockBody: getFieldValue(ruleMockBodyEl),
    },
  };
}

async function loadState() {
  const response = await browser.runtime.sendMessage({ type: "GET_NETWORK_RULES" });
  if (response?.ok) {
    rulesState = response.state || defaultNetworkRulesState();
    lastPersistedRulesSnapshot = JSON.stringify(rulesState);
  }
  rulesEnabledEl.checked = rulesState.enabled !== false;
  renderRulesList();
}

async function loadLog() {
  const stored = await browser.storage.session.get(NETWORK_RULES_LOG_KEY);
  renderLog(stored[NETWORK_RULES_LOG_KEY] || []);
}

function syncTemplateSelectWidth() {
  if (!ruleTemplateSelectEl) {
    return;
  }

  const select = ruleTemplateSelectEl;
  const style = getComputedStyle(select);
  const measure = document.createElement("span");
  measure.style.position = "absolute";
  measure.style.visibility = "hidden";
  measure.style.whiteSpace = "nowrap";
  measure.style.font = style.font;
  document.body.appendChild(measure);

  let maxWidth = 0;
  for (const option of select.options) {
    measure.textContent = option.text;
    maxWidth = Math.max(maxWidth, measure.offsetWidth);
  }
  measure.remove();

  const horizontalPadding =
    (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const border =
    (parseFloat(style.borderLeftWidth) || 0) +
    (parseFloat(style.borderRightWidth) || 0);
  select.style.width = `${Math.ceil(maxWidth + horizontalPadding + border + 22)}px`;
}

function renderRuleTemplateSelect() {
  if (!ruleTemplateSelectEl) {
    return;
  }

  ruleTemplateSelectEl.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Insert from template…";
  ruleTemplateSelectEl.appendChild(placeholder);

  for (const template of ruleTemplates) {
    const option = document.createElement("option");
    option.value = template.id;
    option.textContent = template.name;
    option.title = template.description || "";
    ruleTemplateSelectEl.appendChild(option);
  }

  syncTemplateSelectWidth();
}

async function loadRuleTemplates() {
  try {
    ruleTemplates = await loadNetworkRuleTemplates();
  } catch (error) {
    ruleTemplates = [];
    showMessage(error.message || String(error));
  }
  renderRuleTemplateSelect();
}

document.getElementById("add-rule-btn").addEventListener("click", () => {
  hideMessage();
  const rule = createEmptyRule();
  rulesState.rules.push(rule);
  selectedRuleId = rule.id;
  renderRulesList();
  loadRuleIntoForm(rule);
});

if (ruleTemplateSelectEl) {
  ruleTemplateSelectEl.addEventListener("change", () => {
    insertRuleFromTemplate(ruleTemplateSelectEl.value);
  });
}

document.getElementById("reinject-btn").addEventListener("click", async () => {
  hideMessage();
  const response = await browser.runtime.sendMessage({
    type: "REFRESH_NETWORK_RULES",
  });
  if (response?.ok) {
    showMessage("Re-injected network hook on open tabs.");
  } else {
    showMessage(response?.error || "Re-inject failed.");
  }
});

rulesEnabledEl.addEventListener("change", async () => {
  hideMessage();
  rulesState.enabled = rulesEnabledEl.checked;
  await persistRulesState();
  showMessage(rulesState.enabled ? "Rules enabled." : "Rules disabled.");
});

ruleActionEl.addEventListener("change", updateActionSections);

ruleFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessage();

  const existing = getSelectedRule();
  if (!existing) {
    showMessage("Select or add a rule first.");
    return;
  }

  try {
    const nextRule = readRuleFromForm(existing);
    rulesState.rules = rulesState.rules.map((rule) =>
      rule.id === existing.id ? nextRule : rule
    );
    await persistRulesState();
    selectedRuleId = nextRule.id;
    renderRulesList();
    loadRuleIntoForm(nextRule);
    showMessage(`Saved "${nextRule.name}".`);
  } catch (error) {
    showMessage(error.message || String(error));
  }
});

deleteRuleBtn.addEventListener("click", () => {
  const existing = getSelectedRule();
  if (!existing) {
    return;
  }
  deleteRuleById(existing.id);
});

document.getElementById("clear-log-btn").addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "CLEAR_NETWORK_RULE_LOG" });
  renderLog([]);
});

document.querySelectorAll("[data-add-replacement]").forEach((button) => {
  button.addEventListener("click", () => {
    const key = button.dataset.addReplacement;
    const container =
      key === "urlReplacements"
        ? urlReplacementsEl
        : key === "bodyReplacements"
          ? bodyReplacementsEl
          : headerReplacementsEl;
    container.appendChild(
      createReplacementRow(
        { find: "", replace: "", isRegex: false, name: "" },
        { header: key === "headerReplacements" }
      )
    );
  });
});

document.querySelector("[data-add-set-header]").addEventListener("click", () => {
  setHeadersEl.appendChild(createSetHeaderRow({ name: "", value: "" }));
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[NETWORK_RULES_LOG_KEY]) {
    renderLog(changes[NETWORK_RULES_LOG_KEY].newValue || []);
  }
  if (area === "local" && changes[NETWORK_RULES_KEY]) {
    const incoming = changes[NETWORK_RULES_KEY].newValue;
    if (!incoming) {
      return;
    }
    const incomingSnapshot = JSON.stringify(incoming);
    if (
      incomingSnapshot === lastPersistedRulesSnapshot ||
      incomingSnapshot === JSON.stringify(rulesState)
    ) {
      return;
    }
    rulesState = incoming;
    lastPersistedRulesSnapshot = incomingSnapshot;
    rulesEnabledEl.checked = rulesState.enabled !== false;
    renderRulesList();
    loadRuleIntoForm(getSelectedRule());
  }
});

loadRuleTemplates();
loadState();
loadLog();
