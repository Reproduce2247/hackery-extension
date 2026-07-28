import {
  addCustomLinks,
  getCustomSectionChildren,
  removeCustomLinkById,
  updateCustomLink,
  getLinksOverlayForExport,
} from "../popup/link-storage.js";
import {
  buildLinkNodeFromForm,
  readBuilderForm,
  populateBuilderForm,
  clearBuilderForm,
  getBuilderFormElements,
  consumeBuilderPrefill,
  applyTabPrefill,
  initBuilderForm,
  updateBuilderFieldVisibility,
} from "../popup/link-builder.js";
import { downloadCustomSectionJson } from "../popup/link-export.js";

const {
  parseImportedLinkNodes,
  validateImportNode,
  normalizeImportedNodes,
} = globalThis.SnLinksLinkCatalog;

const { LINKS_OVERLAY_KEY } = globalThis.SnLinksStorageKeys;

const linksListEl = document.getElementById("links-list");
const linkCountEl = document.getElementById("link-count");
const messageEl = document.getElementById("message");
const linkFormEl = document.getElementById("link-form");
const editorTitleEl = document.getElementById("editor-title");
const importPanelEl = document.getElementById("import-panel");
const importJsonInput = document.getElementById("link-import-json");
const deleteLinkBtn = document.getElementById("delete-link-btn");

const builderElements = getBuilderFormElements();

let customLinks = [];
let selectedLinkId = null;

const { showMessage, hideMessage } = globalThis.createUiMessage(messageEl);

function typeBadge(type) {
  if (type === "scriptlet") return "Run";
  if (type === "derived-url") return "Derive";
  if (type === "navigate") return "Open";
  return type || "Link";
}

function getSelectedLink() {
  return customLinks.find((link) => link.id === selectedLinkId) || null;
}

function selectLink(linkId) {
  selectedLinkId = linkId;
  const link = getSelectedLink();
  if (!link) {
    editorTitleEl.textContent = "New link";
    deleteLinkBtn.disabled = true;
    renderLinksList();
    return;
  }

  populateBuilderForm(builderElements, link);
  editorTitleEl.textContent = link.displayName || link.name;
  deleteLinkBtn.disabled = false;
  renderLinksList();
}

function renderLinksList() {
  linksListEl.replaceChildren();
  linkCountEl.textContent = `${customLinks.length} link${
    customLinks.length === 1 ? "" : "s"
  }`;

  if (customLinks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "editor-empty";
    empty.textContent = "No custom links yet.";
    linksListEl.appendChild(empty);
    return;
  }

  for (const link of customLinks) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "link-item";
    button.classList.toggle("active", link.id === selectedLinkId);

    const badge = document.createElement("span");
    badge.className = "link-item-badge";
    badge.textContent = typeBadge(link.type);

    const label = document.createElement("span");
    label.className = "link-item-label";
    label.textContent = link.displayName || link.name;

    button.appendChild(badge);
    button.appendChild(label);
    button.addEventListener("click", () => selectLink(link.id));
    linksListEl.appendChild(button);
  }
}

async function reloadLinks() {
  customLinks = await getCustomSectionChildren();
  if (selectedLinkId && !customLinks.some((link) => link.id === selectedLinkId)) {
    selectedLinkId = null;
    await startNewLink();
  } else if (selectedLinkId) {
    populateBuilderForm(builderElements, getSelectedLink());
  }
  renderLinksList();
}

async function saveCurrentLink(event) {
  event.preventDefault();
  hideMessage();

  try {
    const form = readBuilderForm(builderElements);
    const node = buildLinkNodeFromForm(form);

    if (form.editId) {
      await updateCustomLink(form.editId, node);
      selectedLinkId = form.editId;
      showMessage(`Saved "${node.name}".`);
    } else {
      await addCustomLinks([node]);
      selectedLinkId = node.id;
      builderElements.editIdInput.value = node.id;
      showMessage(`Added "${node.name}".`);
    }

    await reloadLinks();
    selectLink(selectedLinkId);
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

async function deleteCurrentLink() {
  const link = getSelectedLink();
  if (!link?.id) {
    return;
  }

  hideMessage();
  await removeCustomLinkById(link.id);
  selectedLinkId = null;
  await startNewLink();
  await reloadLinks();
  showMessage(`Deleted "${link.name}".`);
}

async function startNewLink() {
  hideMessage();
  selectedLinkId = null;
  clearBuilderForm(builderElements);
  editorTitleEl.textContent = "New link";
  deleteLinkBtn.disabled = true;

  const prefill = await consumeBuilderPrefill();
  if (prefill) {
    applyTabPrefill(builderElements, prefill, "navigate");
  } else {
    updateBuilderFieldVisibility(builderElements);
  }

  builderElements.nameInput.focus();
  renderLinksList();
}

async function importLinks() {
  hideMessage();
  const raw = importJsonInput.value.trim();
  if (!raw) {
    showMessage("Paste JSON to import.");
    importJsonInput.focus();
    return;
  }

  try {
    const parsed = parseImportedLinkNodes(raw);
    parsed.forEach((node, index) => validateImportNode(node, String(index)));
    const nodes = normalizeImportedNodes(parsed);
    await addCustomLinks(nodes);
    importJsonInput.value = "";
    importPanelEl.classList.add("hidden");
    await reloadLinks();
    if (nodes.length === 1 && nodes[0].id) {
      selectLink(nodes[0].id);
    }
    showMessage(`Imported ${nodes.length} link(s).`);
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

async function exportCustomLinks() {
  hideMessage();
  try {
    const overlay = await getLinksOverlayForExport();
    if (!overlay.Custom?.children?.length) {
      showMessage("No custom links to export.");
      return;
    }
    downloadCustomSectionJson(overlay);
    showMessage("Downloaded custom-links.json.");
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

function readEditIdFromQuery() {
  return new URLSearchParams(window.location.search).get("edit");
}

async function init() {
  initBuilderForm(builderElements);

  linkFormEl.addEventListener("submit", saveCurrentLink);
  deleteLinkBtn.addEventListener("click", deleteCurrentLink);
  document.getElementById("clear-form-btn").addEventListener("click", async () => {
    if (selectedLinkId) {
      selectLink(selectedLinkId);
      return;
    }
    await startNewLink();
  });
  document.getElementById("new-link-btn").addEventListener("click", () => {
    startNewLink();
  });
  document.getElementById("export-custom-btn").addEventListener("click", exportCustomLinks);
  document.getElementById("import-toggle-btn").addEventListener("click", () => {
    importPanelEl.classList.toggle("hidden");
    if (!importPanelEl.classList.contains("hidden")) {
      importJsonInput.focus();
    }
  });
  document.getElementById("import-cancel-btn").addEventListener("click", () => {
    importPanelEl.classList.add("hidden");
  });
  document.getElementById("link-import-btn").addEventListener("click", importLinks);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[LINKS_OVERLAY_KEY]) {
      reloadLinks().catch((error) => {
        showMessage(error.message || String(error));
      });
    }
  });

  await reloadLinks();

  const editId = readEditIdFromQuery();
  if (editId && customLinks.some((link) => link.id === editId)) {
    selectLink(editId);
  } else {
    await startNewLink();
  }
}

init().catch((error) => {
  showMessage(error.message || String(error));
});
