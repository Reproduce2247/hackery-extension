const { CUSTOM_SECTION_NAME, mergeLinksCatalog, ensureLinksOverlayInStorage } =
  globalThis.SnLinksLinkCatalog;

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

export async function getCustomSectionChildren() {
  const overlay = await ensureLinksOverlay();
  return overlay[CUSTOM_SECTION_NAME].children;
}

export async function saveCustomSectionChildren(children) {
  const overlay = await ensureLinksOverlay();
  overlay[CUSTOM_SECTION_NAME] = {
    ...overlay[CUSTOM_SECTION_NAME],
    children,
  };
  await browser.storage.local.set({ [LINKS_OVERLAY_KEY]: overlay });
}

export async function addCustomLinks(nodes) {
  const { ensureLinkId } = globalThis.SnLinksLinkCatalog;
  const children = await getCustomSectionChildren();
  await saveCustomSectionChildren(
    children.concat(nodes.map((node) => ensureLinkId(node)))
  );
}

export async function removeCustomLinkById(linkId) {
  const children = await getCustomSectionChildren();
  await saveCustomSectionChildren(children.filter((node) => node.id !== linkId));
}

export async function updateCustomLink(linkId, nextNode) {
  const children = await getCustomSectionChildren();
  const index = children.findIndex((node) => node.id === linkId);
  if (index === -1) {
    throw new Error("Custom link not found.");
  }
  const nextChildren = children.slice();
  nextChildren[index] = { ...nextNode, id: linkId };
  await saveCustomSectionChildren(nextChildren);
}

export async function getLinksOverlayForExport() {
  return ensureLinksOverlay();
}
