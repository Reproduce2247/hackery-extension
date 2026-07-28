export function setFieldVisible(el, visible) {
  if (!el) {
    return;
  }
  el.classList.toggle("is-hidden", !visible);
}

const STRING_SOURCE_OPTIONS = [
  { value: "textContent", label: "textContent" },
  { value: "innerHTML", label: "innerHTML" },
  { value: "id", label: "id" },
  { value: "attribute", label: "attribute" },
];

function parseChoices(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  const choices = trimmed
    .split(",")
    .map((choice) => choice.trim())
    .filter(Boolean);
  return choices.length ? choices : undefined;
}

function readSingleParameter(container) {
  const name = container.querySelector('[data-field="param-name"]')?.value.trim();
  if (!name) {
    return undefined;
  }
  const parameter = { name };
  const placeholder = container.querySelector('[data-field="param-placeholder"]')?.value.trim();
  const defaultValue = container.querySelector('[data-field="param-default"]')?.value.trim();
  const optional = container.querySelector('[data-field="param-optional"]')?.checked;
  const choices = parseChoices(
    container.querySelector('[data-field="param-choices"]')?.value
  );
  if (placeholder) {
    parameter.placeholder = placeholder;
  }
  if (defaultValue) {
    parameter.default = defaultValue;
  }
  if (optional) {
    parameter.optional = true;
  }
  if (choices) {
    parameter.choices = choices;
  }
  return parameter;
}

function readMultipleParameters(listEl) {
  const parameters = {};
  for (const row of listEl.querySelectorAll(".parameter-row")) {
    const name = row.querySelector('[data-field="param-name"]')?.value.trim();
    if (!name) {
      continue;
    }
    const config = {};
    const placeholder = row.querySelector('[data-field="param-placeholder"]')?.value.trim();
    const defaultValue = row.querySelector('[data-field="param-default"]')?.value.trim();
    const optional = row.querySelector('[data-field="param-optional"]')?.checked;
    const choices = parseChoices(row.querySelector('[data-field="param-choices"]')?.value);
    if (placeholder) {
      config.placeholder = placeholder;
    }
    if (defaultValue) {
      config.default = defaultValue;
    }
    if (optional) {
      config.optional = true;
    }
    if (choices) {
      config.choices = choices;
    }
    parameters[name] = config;
  }
  return Object.keys(parameters).length ? parameters : undefined;
}

function readExtractList(listEl) {
  const extract = {};
  for (const row of listEl.querySelectorAll(".extract-row")) {
    const paramName = row.querySelector('[data-field="extract-name"]')?.value.trim();
    if (!paramName) {
      continue;
    }
    const kind = row.querySelector('[data-field="extract-kind"]')?.value || "url";
    if (kind === "url") {
      const pattern = row.querySelector('[data-field="extract-url"]')?.value.trim();
      if (pattern) {
        extract[paramName] = { url: pattern };
      }
      continue;
    }
    const selector = row.querySelector('[data-field="extract-selector"]')?.value.trim();
    if (!selector) {
      continue;
    }
    const spec = { selector };
    const stringSource = row.querySelector('[data-field="extract-string-source"]')?.value;
    if (stringSource) {
      spec.stringSource = stringSource;
    }
    const attribute = row.querySelector('[data-field="extract-attribute"]')?.value.trim();
    if (attribute) {
      spec.attribute = attribute;
    }
    extract[paramName] = spec;
  }
  return Object.keys(extract).length ? extract : undefined;
}

function fillSingleParameter(container, parameter = {}) {
  container.querySelector('[data-field="param-name"]').value = parameter.name || "";
  container.querySelector('[data-field="param-placeholder"]').value =
    parameter.placeholder || "";
  container.querySelector('[data-field="param-default"]').value = parameter.default ?? "";
  container.querySelector('[data-field="param-optional"]').checked = Boolean(
    parameter.optional
  );
  container.querySelector('[data-field="param-choices"]').value = Array.isArray(
    parameter.choices
  )
    ? parameter.choices.join(", ")
    : "";
}

function createParameterRow(values = {}) {
  const row = document.createElement("div");
  row.className = "parameter-row builder-row";
  row.innerHTML = `
    <input data-field="param-name" type="text" placeholder="name" />
    <input data-field="param-placeholder" type="text" placeholder="placeholder" />
    <input data-field="param-default" type="text" placeholder="default" />
    <label class="inline-check"><input data-field="param-optional" type="checkbox" /> Optional</label>
    <input data-field="param-choices" type="text" placeholder="choices, comma, separated" />
    <button type="button" class="row-remove secondary" title="Remove">×</button>
  `;
  row.querySelector('[data-field="param-name"]').value = values.name || "";
  row.querySelector('[data-field="param-placeholder"]').value = values.placeholder || "";
  row.querySelector('[data-field="param-default"]').value = values.default ?? "";
  row.querySelector('[data-field="param-optional"]').checked = Boolean(values.optional);
  row.querySelector('[data-field="param-choices"]').value = Array.isArray(values.choices)
    ? values.choices.join(", ")
    : "";
  row.querySelector(".row-remove").addEventListener("click", () => row.remove());
  return row;
}

function updateExtractRowVisibility(row) {
  const kind = row.querySelector('[data-field="extract-kind"]')?.value || "url";
  const isUrl = kind === "url";
  setFieldVisible(
    row.querySelector('[data-field="extract-url"]')?.closest(".extract-url-field"),
    isUrl
  );
  setFieldVisible(row.querySelector(".extract-dom-fields"), !isUrl);
  const stringSource = row.querySelector('[data-field="extract-string-source"]')?.value;
  setFieldVisible(
    row.querySelector('[data-field="extract-attribute"]')?.closest(".extract-attribute-field"),
    stringSource === "attribute"
  );
}

function createExtractRow(values = {}) {
  const row = document.createElement("div");
  row.className = "extract-row builder-row";
  row.innerHTML = `
    <input data-field="extract-name" type="text" placeholder="param name" />
    <select data-field="extract-kind">
      <option value="url">URL regex</option>
      <option value="dom">DOM selector</option>
    </select>
    <div class="extract-url-field">
      <input data-field="extract-url" type="text" placeholder="regex (capture group 1)" />
    </div>
    <div class="extract-dom-fields is-hidden">
      <input data-field="extract-selector" type="text" placeholder="CSS selector" />
      <select data-field="extract-string-source">
        ${STRING_SOURCE_OPTIONS.map(
          (option) =>
            `<option value="${option.value}">${option.label}</option>`
        ).join("")}
      </select>
      <div class="extract-attribute-field is-hidden">
        <input data-field="extract-attribute" type="text" placeholder="attribute name" />
      </div>
    </div>
    <button type="button" class="row-remove secondary" title="Remove">×</button>
  `;

  const kindSelect = row.querySelector('[data-field="extract-kind"]');
  const sourceSelect = row.querySelector('[data-field="extract-string-source"]');
  kindSelect.addEventListener("change", () => updateExtractRowVisibility(row));
  sourceSelect.addEventListener("change", () => updateExtractRowVisibility(row));
  row.querySelector(".row-remove").addEventListener("click", () => row.remove());

  if (values.url) {
    kindSelect.value = "url";
    row.querySelector('[data-field="extract-url"]').value = values.url;
  } else if (values.selector) {
    kindSelect.value = "dom";
    row.querySelector('[data-field="extract-selector"]').value = values.selector;
    sourceSelect.value = values.stringSource || "textContent";
    row.querySelector('[data-field="extract-attribute"]').value = values.attribute || "";
  }
  if (values.paramName) {
    row.querySelector('[data-field="extract-name"]').value = values.paramName;
  }

  updateExtractRowVisibility(row);
  return row;
}

export function wireBuilderFieldUi(fieldElements) {
  fieldElements.hostPatternModeSelect.addEventListener("change", () => {
    updateHostPatternFieldVisibility(fieldElements);
  });
  fieldElements.parameterModeSelect.addEventListener("change", () => {
    updateParameterModeVisibility(fieldElements);
  });
  fieldElements.addParameterBtn.addEventListener("click", () => {
    fieldElements.multipleParametersList.appendChild(createParameterRow());
  });
  fieldElements.addExtractBtn.addEventListener("click", () => {
    fieldElements.extractList.appendChild(createExtractRow());
  });
}

export function updateHostPatternFieldVisibility(fieldElements) {
  const mode = fieldElements.hostPatternModeSelect.value;
  setFieldVisible(fieldElements.hostPatternCustomField, mode === "custom");
}

export function updateParameterModeVisibility(fieldElements) {
  const mode = fieldElements.parameterModeSelect.value;
  setFieldVisible(fieldElements.singleParameterFields, mode === "single");
  setFieldVisible(fieldElements.multipleParametersPanel, mode === "multiple");
}

export function readHostPattern(fieldElements) {
  const mode = fieldElements.hostPatternModeSelect.value;
  if (mode === "inherit") {
    return undefined;
  }
  if (mode === "none") {
    return null;
  }
  const custom = fieldElements.hostPatternCustomInput.value.trim();
  if (!custom) {
    throw new Error("Enter a host pattern regex or choose inherit/none.");
  }
  return custom;
}

export function populateHostPattern(fieldElements, hostPattern) {
  if (hostPattern === null) {
    fieldElements.hostPatternModeSelect.value = "none";
  } else if (hostPattern === undefined) {
    fieldElements.hostPatternModeSelect.value = "inherit";
    fieldElements.hostPatternCustomInput.value = "";
  } else {
    fieldElements.hostPatternModeSelect.value = "custom";
    fieldElements.hostPatternCustomInput.value = hostPattern;
  }
  updateHostPatternFieldVisibility(fieldElements);
}

export function readParameterFields(fieldElements) {
  const mode = fieldElements.parameterModeSelect.value;
  if (mode === "single") {
    const parameter = readSingleParameter(fieldElements.singleParameterFields);
    return parameter ? { parameter } : {};
  }
  if (mode === "multiple") {
    const parameters = readMultipleParameters(fieldElements.multipleParametersList);
    return parameters ? { parameters } : {};
  }
  return {};
}

export function populateParameterFields(fieldElements, node) {
  fieldElements.multipleParametersList.replaceChildren();
  if (node.parameter && !Array.isArray(node.parameter)) {
    fieldElements.parameterModeSelect.value = "single";
    fillSingleParameter(fieldElements.singleParameterFields, node.parameter);
  } else if (node.parameters && typeof node.parameters === "object") {
    fieldElements.parameterModeSelect.value = "multiple";
    for (const [name, config] of Object.entries(node.parameters)) {
      fieldElements.multipleParametersList.appendChild(
        createParameterRow({ name, ...config })
      );
    }
  } else {
    fieldElements.parameterModeSelect.value = "none";
    fillSingleParameter(fieldElements.singleParameterFields, {});
  }
  updateParameterModeVisibility(fieldElements);
}

export function clearParameterFields(fieldElements) {
  fieldElements.parameterModeSelect.value = "none";
  fillSingleParameter(fieldElements.singleParameterFields, {});
  fieldElements.multipleParametersList.replaceChildren();
  updateParameterModeVisibility(fieldElements);
}

export function populateExtractFields(fieldElements, extract) {
  fieldElements.extractList.replaceChildren();
  if (!extract || typeof extract !== "object") {
    return;
  }
  for (const [paramName, spec] of Object.entries(extract)) {
    fieldElements.extractList.appendChild(
      createExtractRow({ paramName, ...spec })
    );
  }
}

export function readExtractFields(fieldElements) {
  return readExtractList(fieldElements.extractList);
}

export function clearExtractFields(fieldElements) {
  fieldElements.extractList.replaceChildren();
}

export function getBuilderFieldElements(root = document) {
  return {
    hostPatternModeSelect: root.getElementById("host-pattern-mode"),
    hostPatternCustomInput: root.getElementById("host-pattern-custom"),
    hostPatternCustomField: root.getElementById("host-pattern-custom-field"),
    parameterModeSelect: root.getElementById("parameter-mode"),
    singleParameterFields: root.getElementById("single-parameter-fields"),
    multipleParametersPanel: root.getElementById("multiple-parameters-panel"),
    multipleParametersList: root.getElementById("multiple-parameters-list"),
    addParameterBtn: root.getElementById("add-parameter-btn"),
    extractSection: root.getElementById("extract-section"),
    extractList: root.getElementById("extract-list"),
    addExtractBtn: root.getElementById("add-extract-btn"),
    parametersSection: root.getElementById("parameters-section"),
  };
}
