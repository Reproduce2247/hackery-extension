import {
  loadParamValues,
  saveParamValue,
  readParamValuesFromRow,
} from "./activate-link.js";
import { getTargetTab } from "./tab-target.js";

const {
  linkBadgeLabel,
  linkBadgeClass,
  displayHint,
  matchBehavior,
  formatOpenHint,
} = globalThis.SnLinksBehaviors;

const {
  INJECT_ON_LOAD_KEY,
  getEditableValueDefs,
  linkStorageKey,
  resolveMatch,
  resolveParamValues,
  nodeHasOnLoad,
} = globalThis.SnLinksLinkModel;

let openCombobox = null;
let openContextMenu = null;

export function closeOpenContextMenu() {
  if (!openContextMenu) {
    return;
  }
  openContextMenu.remove();
  openContextMenu = null;
}

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
  if (openContextMenu && !openContextMenu.contains(event.target)) {
    closeOpenContextMenu();
  }
}

function showLinkContextMenu(event, node, row, { copyLink, exportLinkJson, editCustomLink }) {
  event.preventDefault();
  event.stopPropagation();
  closeOpenCombobox();
  closeOpenContextMenu();

  const menu = document.createElement("div");
  menu.className = "link-context-menu";
  menu.setAttribute("role", "menu");

  const copyItem = document.createElement("button");
  copyItem.type = "button";
  copyItem.className = "link-context-menu-item";
  copyItem.setAttribute("role", "menuitem");
  copyItem.textContent = "Copy";
  copyItem.addEventListener("mousedown", (mousedownEvent) => {
    mousedownEvent.preventDefault();
    mousedownEvent.stopPropagation();
  });
  copyItem.addEventListener("click", (clickEvent) => {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
    closeOpenContextMenu();
    copyLink(node, row);
  });
  menu.appendChild(copyItem);

  const exportItem = document.createElement("button");
  exportItem.type = "button";
  exportItem.className = "link-context-menu-item";
  exportItem.setAttribute("role", "menuitem");
  exportItem.textContent = "Export JSON";
  exportItem.addEventListener("mousedown", (mousedownEvent) => {
    mousedownEvent.preventDefault();
    mousedownEvent.stopPropagation();
  });
  exportItem.addEventListener("click", (clickEvent) => {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();
    closeOpenContextMenu();
    exportLinkJson(node);
  });
  menu.appendChild(exportItem);

  if (editCustomLink && node.id) {
    const editItem = document.createElement("button");
    editItem.type = "button";
    editItem.className = "link-context-menu-item";
    editItem.setAttribute("role", "menuitem");
    editItem.textContent = "Edit in builder";
    editItem.addEventListener("mousedown", (mousedownEvent) => {
      mousedownEvent.preventDefault();
      mousedownEvent.stopPropagation();
    });
    editItem.addEventListener("click", (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      closeOpenContextMenu();
      editCustomLink(node);
    });
    menu.appendChild(editItem);
  }
  document.body.appendChild(menu);

  const menuRect = menu.getBoundingClientRect();
  const left = Math.max(
    8,
    Math.min(event.clientX, window.innerWidth - menuRect.width - 8)
  );
  const top = Math.max(
    8,
    Math.min(event.clientY, window.innerHeight - menuRect.height - 8)
  );
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  openContextMenu = menu;
}

function buildParameterDef(def) {
  return {
    ...def,
    placeholder:
      def.placeholder !== undefined && def.placeholder !== ""
        ? def.placeholder
        : def.name,
  };
}

function getUiParameterDefs(node) {
  return getEditableValueDefs(node).map((def) => buildParameterDef(def));
}

function displayLabel(node) {
  return node.displayName || node.name;
}

async function resolveNavScriptletHint(node, row, parameterDefs) {
  const { resolveNavScriptletUrl } = globalThis.SnLinksNav;
  const { formatOpenHint } = globalThis.SnLinksBehaviors;
  const paramValues = resolveParamValues(
    parameterDefs,
    readParamValuesFromRow(row, parameterDefs)
  );
  const matchPattern = node.match ?? null;
  const { tab, origin } = await getTargetTab(matchPattern);
  const url =
    resolveNavScriptletUrl(node.code, tab.url, origin, tab, paramValues) ||
    "Navigation script";
  return formatOpenHint(node.open, url);
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

export function createLinkUi({ activateLink, copyLink, exportLinkJson, editCustomLink, setInjectOnLoad }) {
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
    if (options.isCustom) {
      button.classList.add("is-custom");
    }
    button.dataset.behavior = matchBehavior(node)?.id || "";

    const badge = document.createElement("span");
    badge.className = linkBadgeClass(node);
    badge.textContent = linkBadgeLabel(node);

    const labelWrap = document.createElement("span");
    labelWrap.className = "link-label";
    labelWrap.textContent = displayLabel(node);

    const hint = document.createElement("span");
    hint.className = "link-hint";
    const updateHint = () => {
      const behavior = matchBehavior(node);
      if (behavior?.id === "open-from-script") {
        hint.textContent = displayHint(node) || "…";
        resolveNavScriptletHint(node, row, parameterDefs)
          .then((text) => {
            hint.textContent = text;
          })
          .catch(() => {
            hint.textContent = formatOpenHint(node.open, "Navigation script");
          });
        return;
      }
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
    row.addEventListener("contextmenu", (event) => {
      showLinkContextMenu(event, node, row, {
        copyLink,
        exportLinkJson,
        editCustomLink: options.isCustom ? editCustomLink : null,
      });
    });
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
      const hostHint = node.match
        ? `Inject at document start when tab URL matches /${node.match}/`
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
    inheritedMatch = null,
    sectionName = null,
    injectOnLoad = {},
    options = {}
  ) {
    const { isCustomLink } = globalThis.SnLinksLinkCatalog;

    for (const node of nodes) {
      const matchPattern = resolveMatch(node, inheritedMatch);
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
          matchPattern,
          sectionName,
          injectOnLoad,
          options
        );
        container.appendChild(folder);
        continue;
      }

      container.appendChild(
        createLinkRow(
          { ...node, match: matchPattern, sectionName },
          {
            savedParamValues,
            injectOnLoad,
            showRemove: options.showRemoveColumn,
            isCustom: isCustomLink(node),
            onDelete:
              isCustomLink(node) && node.id && options.onDeleteCustom
                ? async (event) => {
                    event.stopPropagation();
                    await options.onDeleteCustom(node.id);
                  }
                : null,
          }
        )
      );
    }
  }

  return {
    displayLabel,
    createLinkListHeader,
    createLinkRow,
    renderNodes,
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
