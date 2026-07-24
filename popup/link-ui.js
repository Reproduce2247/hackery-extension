import {
  loadParamValues,
  saveParamValue,
  readParamValuesFromRow,
} from "./activate-link.js";

const {
  toNavigatorPath,
  isAbsoluteUrl,
} = globalThis.SnLinksNav;

const {
  INJECT_ON_LOAD_KEY,
  CUSTOM_SCRIPTS_KEY,
  extractNavigationPath,
  getParameterConfig,
  getParameterDefs,
  linkStorageKey,
  resolveHostPattern,
  resolveParamValues,
  nodeHasOnLoad,
} = globalThis.SnLinksLinkModel;

let openCombobox = null;

export function closeOpenCombobox() {
  if (!openCombobox) {
    return;
  }
  openCombobox.list.hidden = true;
  if (openCombobox.onScroll) {
    window.removeEventListener("scroll", openCombobox.onScroll, true);
  }
  openCombobox = null;
}

export function handleDocumentClickForCombobox(event) {
  if (openCombobox && !openCombobox.root.contains(event.target)) {
    closeOpenCombobox();
  }
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

function getUiParameterDefs(node) {
  return getParameterDefs(node).map((def) => ({
    ...def,
    ...buildParameterDef(node, def.name),
  }));
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
  const { resolveNode } = globalThis.SnLinksLinkModel;
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
    return resolved.url
      ? resolved.url
          .replace(/\{encode:[^}]+\}/g, "…")
          .replace(/\{[^}]+\}/g, "…")
      : "";
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
  return getUiParameterDefs(node).length > 0;
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

export function createLinkUi({ activateLink, setInjectOnLoad }) {
  function createLinkRow(node, options = {}) {
    const parameterDefs = getUiParameterDefs(node);
    const linkKey = linkStorageKey(node);
    const savedValues = options.savedParamValues?.[linkKey] || {};

    const row = document.createElement("div");
    row.className = "link-row";
    if (options.showRemove) {
      row.classList.add("has-remove");
    }
    if (options.searchMatch) {
      row.classList.add("search-match");
    }
    if (options.searchExactMatch) {
      row.classList.add("search-exact-match");
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

  function renderCustomScripts(
    scripts,
    container,
    savedParamValues,
    injectOnLoad,
    query,
    { sortNodesBySearchScore, getScriptSearchRowHighlight, searchMatchScore, onDeleteScript }
  ) {
    const sortedScripts = sortNodesBySearchScore(scripts, (script, activeQuery) =>
      searchMatchScore(script.name, activeQuery)
    );
    if (sortedScripts.length === 0) {
      return;
    }

    const folder = document.createElement("section");
    folder.className = "folder";

    const title = document.createElement("div");
    title.className = "folder-title";
    title.textContent = "Custom scripts";
    folder.appendChild(title);

    for (const script of sortedScripts) {
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
          ...getScriptSearchRowHighlight(script, query),
          onDelete: async (event) => {
            event.stopPropagation();
            await onDeleteScript(script.id);
          },
        })
      );
    }

    container.appendChild(folder);
  }

  return {
    displayLabel,
    createLinkListHeader,
    createLinkRow,
    renderNodes,
    renderCustomScripts,
    nodeHasParams,
    treeHasParams,
    treeHasOnLoad,
  };
}

export async function loadInjectOnLoad() {
  const stored = await browser.storage.local.get(INJECT_ON_LOAD_KEY);
  return stored[INJECT_ON_LOAD_KEY] || {};
}

export async function setInjectOnLoad(linkKey, enabled) {
  const injectOnLoad = await loadInjectOnLoad();
  if (enabled) {
    injectOnLoad[linkKey] = true;
  } else {
    delete injectOnLoad[linkKey];
  }
  await browser.storage.local.set({ [INJECT_ON_LOAD_KEY]: injectOnLoad });
  await browser.runtime.sendMessage({ type: "REFRESH_INJECT" }).catch(() => {});
}

export async function loadCustomScripts() {
  const stored = await browser.storage.local.get(CUSTOM_SCRIPTS_KEY);
  return stored[CUSTOM_SCRIPTS_KEY] || [];
}

export async function saveCustomScripts(scripts) {
  await browser.storage.local.set({ [CUSTOM_SCRIPTS_KEY]: scripts });
}
