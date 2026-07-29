const {
  CUSTOM_SECTION_NAME,
  isHiddenSectionTab,
  mergeLinksCatalog,
  ensureLinksOverlayInStorage,
} = globalThis.SnLinksLinkCatalog;

const { LINKS_OVERLAY_KEY } = globalThis.SnLinksStorageKeys;

export async function loadBundledLinksJson() {
  const response = await fetch(browser.runtime.getURL("data/links.json"));
  return response.json();
}

export async function ensureLinksOverlay() {
  return ensureLinksOverlayInStorage();
}

export async function loadMergedLinkCatalog() {
  const bundled = await loadBundledLinksJson();
  const overlay = await ensureLinksOverlay();
  return mergeLinksCatalog(bundled, overlay);
}

export async function getSectionOverlayChildren(sectionName) {
  const overlay = await ensureLinksOverlay();
  return overlay[sectionName]?.children || [];
}

export async function saveSectionOverlayChildren(sectionName, children) {
  const overlay = await ensureLinksOverlay();
  overlay[sectionName] = {
    ...(overlay[sectionName] || {}),
    children,
  };
  await browser.storage.local.set({ [LINKS_OVERLAY_KEY]: overlay });
}

export async function addLinksToSection(sectionName, nodes) {
  const { ensureLinkId } = globalThis.SnLinksLinkCatalog;
  const children = await getSectionOverlayChildren(sectionName);
  await saveSectionOverlayChildren(
    sectionName,
    children.concat(nodes.map((node) => ensureLinkId(node)))
  );
}

export async function findCustomLinkById(linkId) {
  const overlay = await ensureLinksOverlay();
  for (const [sectionName, section] of Object.entries(overlay)) {
    if (isHiddenSectionTab(sectionName) || !Array.isArray(section?.children)) {
      continue;
    }
    const index = section.children.findIndex((node) => node.id === linkId);
    if (index !== -1) {
      return { sectionName, index, node: section.children[index] };
    }
  }
  return null;
}

export async function removeCustomLinkById(linkId) {
  const found = await findCustomLinkById(linkId);
  if (!found) {
    return;
  }

  const overlay = await ensureLinksOverlay();
  const children = overlay[found.sectionName].children.filter(
    (node) => node.id !== linkId
  );
  overlay[found.sectionName] = {
    ...overlay[found.sectionName],
    children,
  };
  await browser.storage.local.set({ [LINKS_OVERLAY_KEY]: overlay });
}

export async function updateCustomLink(linkId, nextNode, targetSectionName) {
  const found = await findCustomLinkById(linkId);
  if (!found) {
    throw new Error("Custom link not found.");
  }

  const overlay = await ensureLinksOverlay();
  const node = { ...nextNode, id: linkId };
  const sectionName = targetSectionName || found.sectionName;

  if (sectionName === found.sectionName) {
    const nextChildren = overlay[found.sectionName].children.slice();
    nextChildren[found.index] = node;
    overlay[found.sectionName] = {
      ...overlay[found.sectionName],
      children: nextChildren,
    };
  } else {
    overlay[found.sectionName] = {
      ...overlay[found.sectionName],
      children: overlay[found.sectionName].children.filter(
        (entry) => entry.id !== linkId
      ),
    };
    overlay[sectionName] = {
      ...(overlay[sectionName] || {}),
      children: (overlay[sectionName]?.children || []).concat(node),
    };
  }

  await browser.storage.local.set({ [LINKS_OVERLAY_KEY]: overlay });
}

export async function getAllCustomLinks() {
  const overlay = await ensureLinksOverlay();
  const results = [];

  for (const [sectionName, section] of Object.entries(overlay)) {
    if (isHiddenSectionTab(sectionName) || !Array.isArray(section?.children)) {
      continue;
    }
    for (const node of section.children) {
      if (node.id && !node.children) {
        results.push({ ...node, sectionName });
      }
    }
  }

  return results.sort((a, b) =>
    (a.displayName || a.name).localeCompare(b.displayName || b.name)
  );
}

export async function getCatalogSectionNames() {
  const catalog = await loadMergedLinkCatalog();
  return Object.keys(catalog).filter((name) => !isHiddenSectionTab(name));
}

export async function getLinksOverlayForExport() {
  return ensureLinksOverlay();
}

/** @deprecated use getSectionOverlayChildren */
export async function getCustomSectionChildren() {
  return getSectionOverlayChildren(CUSTOM_SECTION_NAME);
}

/** @deprecated use addLinksToSection */
export async function addCustomLinks(nodes, sectionName = CUSTOM_SECTION_NAME) {
  await addLinksToSection(sectionName, nodes);
}
