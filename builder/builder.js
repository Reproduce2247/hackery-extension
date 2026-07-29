import { attachCodeMirrorAll } from "../lib/codemirror-fields.bundle.js";
import {
  addLinksToSection,
  getAllCustomLinks,
  findCustomLinkById,
  removeCustomLinkById,
  updateCustomLink,
  getCatalogSectionNames,
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
  readTargetSection,
} from "../popup/link-builder.js";
import { downloadOverlayJson } from "../popup/link-export.js";

const {
  parseImportedLinkNodes,
  validateImportNode,
  normalizeImportedNodes,
  overlayExport,
  isHiddenSectionTab,
} = globalThis.SnLinksLinkCatalog;

const { LINKS_OVERLAY_KEY, LINK_BUILDER_SECTION_KEY } = globalThis.SnLinksStorageKeys;

const linksListEl = document.getElementById("links-list");
const linkCountEl = document.getElementById("link-count");
const messageEl = document.getElementById("message");
const linkFormEl = document.getElementById("link-form");
const editorTitleEl = document.getElementById("editor-title");
const importFileInput = document.getElementById("import-file-input");
const deleteLinkBtn = document.getElementById("delete-link-btn");

const builderElements = getBuilderFormElements();

attachCodeMirrorAll({
  linkCode: {
    element: builderElements.codeInput,
    language: "javascript",
    minHeight: 120,
  },
  hostPattern: {
    element: builderElements.fieldElements.hostPatternCustomInput,
    language: "regex",
    compact: true,
    placeholder: "e.g. \\.service-now\\.com$",
  },
});

let customLinks = [];
let sectionNames = [];
let selectedLinkId = null;
let defaultSectionName = null;

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

  populateBuilderForm(builderElements, link, link.sectionName, sectionNames);
  editorTitleEl.textContent = link.displayName || link.name;
  deleteLinkBtn.disabled = false;
  renderLinksList();
}

function createLinkDeleteButton(link) {
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "link-item-delete";
  deleteBtn.title = "Delete link";
  deleteBtn.setAttribute("aria-label", `Delete ${link.displayName || link.name}`);
  deleteBtn.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M6 1h4l1 1h3v2H2V2h3l1-1zM3 5h10l-1 9H4L3 5zm3 2v5h1V7H6zm3 0v5h1V7H9z"/></svg>';
  deleteBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteLinkById(link.id);
  });
  return deleteBtn;
}

function renderLinksList() {
  linksListEl.replaceChildren();
  linkCountEl.textContent = `${customLinks.length} link${
    customLinks.length === 1 ? "" : "s"
  }`;

  if (customLinks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "editor-empty";
    empty.textContent = "No user-added links yet.";
    linksListEl.appendChild(empty);
    return;
  }

  for (const link of customLinks) {
    const row = document.createElement("div");
    row.className = "link-item-row";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "link-item";
    button.classList.toggle("active", link.id === selectedLinkId);

    const badge = document.createElement("span");
    badge.className = "link-item-badge";
    badge.textContent = typeBadge(link.type);

    const labelWrap = document.createElement("span");
    labelWrap.className = "link-item-label-wrap";

    const label = document.createElement("span");
    label.className = "link-item-label";
    label.textContent = link.displayName || link.name;

    const sectionHint = document.createElement("span");
    sectionHint.className = "link-item-section";
    sectionHint.textContent = link.sectionName;

    labelWrap.appendChild(label);
    labelWrap.appendChild(sectionHint);

    button.appendChild(badge);
    button.appendChild(labelWrap);
    button.addEventListener("click", () => selectLink(link.id));

    row.appendChild(button);
    row.appendChild(createLinkDeleteButton(link));
    linksListEl.appendChild(row);
  }
}

async function reloadLinks() {
  customLinks = await getAllCustomLinks();
  sectionNames = await getCatalogSectionNames();

  if (selectedLinkId && !customLinks.some((link) => link.id === selectedLinkId)) {
    selectedLinkId = null;
    await startNewLink();
  } else if (selectedLinkId) {
    const link = getSelectedLink();
    populateBuilderForm(builderElements, link, link.sectionName, sectionNames);
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
      await updateCustomLink(form.editId, node, form.sectionName);
      selectedLinkId = form.editId;
      showMessage(`Saved "${node.name}" in ${form.sectionName}.`);
    } else {
      await addLinksToSection(form.sectionName, [node]);
      selectedLinkId = node.id;
      builderElements.editIdInput.value = node.id;
      showMessage(`Added "${node.name}" to ${form.sectionName}.`);
    }

    await reloadLinks();
    selectLink(selectedLinkId);
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

async function deleteLinkById(linkId) {
  const link = customLinks.find((entry) => entry.id === linkId);
  if (!link?.id) {
    return;
  }

  hideMessage();
  await removeCustomLinkById(link.id);

  if (selectedLinkId === linkId) {
    selectedLinkId = null;
    await startNewLink();
  }

  await reloadLinks();
  showMessage(`Deleted "${link.name}".`);
}

async function deleteCurrentLink() {
  const link = getSelectedLink();
  if (!link?.id) {
    return;
  }
  await deleteLinkById(link.id);
}

async function startNewLink(sectionName = defaultSectionName) {
  hideMessage();
  selectedLinkId = null;
  clearBuilderForm(builderElements, sectionNames, sectionName);
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

function isSectionOverlay(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  if (data.type || data.code || data.path || data.url) {
    return false;
  }
  if (Array.isArray(data.children)) {
    return false;
  }

  const entries = Object.entries(data);
  if (!entries.length) {
    return false;
  }

  return entries.every(
    ([, section]) =>
      section &&
      typeof section === "object" &&
      Array.isArray(section.children)
  );
}

async function importLinksFromJson(raw) {
  hideMessage();

  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    showMessage("Choose a JSON file to import.");
    return;
  }

  try {
    const data = JSON.parse(trimmed);

    if (isSectionOverlay(data)) {
      let total = 0;
      const importedSections = [];

      for (const [sectionName, section] of Object.entries(data)) {
        if (isHiddenSectionTab(sectionName)) {
          continue;
        }

        const nodes = normalizeImportedNodes(section.children || []);
        nodes.forEach((node, index) =>
          validateImportNode(node, `${sectionName}.${index}`)
        );

        if (!nodes.length) {
          continue;
        }

        await addLinksToSection(sectionName, nodes);
        total += nodes.length;
        importedSections.push(sectionName);
      }

      if (!total) {
        showMessage("No links found in file.");
        return;
      }

      await reloadLinks();
      showMessage(
        `Imported ${total} link(s) into ${importedSections.join(", ")}.`
      );
      return;
    }

    const targetSection = readTargetSection(builderElements);
    const parsed = parseImportedLinkNodes(data);
    parsed.forEach((node, index) => validateImportNode(node, String(index)));
    const nodes = normalizeImportedNodes(parsed);
    await addLinksToSection(targetSection, nodes);
    await reloadLinks();
    if (nodes.length === 1 && nodes[0].id) {
      selectLink(nodes[0].id);
    }
    showMessage(`Imported ${nodes.length} link(s) into ${targetSection}.`);
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

async function importLinksFromFile(file) {
  if (!file) {
    return;
  }

  try {
    await importLinksFromJson(await file.text());
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

async function exportCustomLinks() {
  hideMessage();
  try {
    const overlay = await getLinksOverlayForExport();
    const exported = overlayExport(overlay);
    if (!Object.keys(exported).length) {
      showMessage("No user-added links to export.");
      return;
    }
    downloadOverlayJson(overlay);
    showMessage("Downloaded custom-links.json.");
  } catch (error) {
    showMessage(error.message || String(error));
  }
}

function readEditIdFromQuery() {
  return new URLSearchParams(window.location.search).get("edit");
}

function readSectionFromQuery() {
  return new URLSearchParams(window.location.search).get("section");
}

async function readDefaultSectionName() {
  const fromQuery = readSectionFromQuery();
  if (fromQuery) {
    return fromQuery;
  }

  const stored = await browser.storage.session.get(LINK_BUILDER_SECTION_KEY);
  const fromSession = stored[LINK_BUILDER_SECTION_KEY];
  if (fromSession) {
    await browser.storage.session.remove(LINK_BUILDER_SECTION_KEY);
    return fromSession;
  }

  return sectionNames[0] || "Misc";
}

async function init() {
  sectionNames = await getCatalogSectionNames();
  defaultSectionName = await readDefaultSectionName();
  if (!sectionNames.includes(defaultSectionName)) {
    sectionNames = [...sectionNames, defaultSectionName].sort((a, b) =>
      a.localeCompare(b)
    );
  }

  initBuilderForm(builderElements, {
    sectionNames,
    defaultSection: defaultSectionName,
  });

  linkFormEl.addEventListener("submit", saveCurrentLink);
  deleteLinkBtn.addEventListener("click", deleteCurrentLink);
  document.getElementById("clear-form-btn").addEventListener("click", async () => {
    if (selectedLinkId) {
      selectLink(selectedLinkId);
      return;
    }
    await startNewLink(defaultSectionName);
  });
  document.getElementById("new-link-btn").addEventListener("click", () => {
    startNewLink(defaultSectionName);
  });
  document.getElementById("export-custom-btn").addEventListener("click", exportCustomLinks);
  document.getElementById("import-btn").addEventListener("click", () => {
    importFileInput.click();
  });
  importFileInput.addEventListener("change", async () => {
    const file = importFileInput.files?.[0];
    importFileInput.value = "";
    await importLinksFromFile(file);
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[LINKS_OVERLAY_KEY]) {
      reloadLinks().catch((error) => {
        showMessage(error.message || String(error));
      });
    }
  });

  await reloadLinks();

  const editId = readEditIdFromQuery();
  if (editId) {
    const found = await findCustomLinkById(editId);
    if (found) {
      selectedLinkId = editId;
      selectLink(editId);
      return;
    }
  }

  await startNewLink(defaultSectionName);
}

init().catch((error) => {
  showMessage(error.message || String(error));
});
