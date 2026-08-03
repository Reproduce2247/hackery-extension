const {
  LEGACY_CUSTOM_MIGRATION_SECTION,
  mergeLinksCatalog,
  importOverlayIntoExisting,
  ensureLinksOverlayInStorage,
} = globalThis.SnLinksLinkCatalog;

const { LINKS_OVERLAY_KEY, CATALOG_ORDER_KEY } = globalThis.SnLinksStorageKeys;

async function persistOverlay(overlay, reason = "overlay") {
  await browser.storage.local.set({ [LINKS_OVERLAY_KEY]: overlay });
  globalThis.SnLinksCatalogEvents?.emitCatalogChanged?.({ reason });
}

export async function loadBundledLinksJson() {
  const response = await fetch(browser.runtime.getURL("data/links.json"));
  return response.json();
}

export async function ensureLinksOverlay() {
  return ensureLinksOverlayInStorage();
}

/**
 * Merged catalog with user catalogOrder applied.
 */
export async function loadMergedLinkCatalog() {
  const Order = globalThis.SnLinksCatalogOrder;
  const bundled = await loadBundledLinksJson();
  const overlay = await ensureLinksOverlay();
  const merged = mergeLinksCatalog(bundled, overlay);
  let order = await Order.loadCatalogOrder();
  const next = Order.appendMissingKeys(order, merged);
  if (
    next.linkKeys.length !== order.linkKeys.length ||
    next.sectionOrder.length !== order.sectionOrder.length
  ) {
    order = next;
    await browser.storage.local.set({ [CATALOG_ORDER_KEY]: order });
  }
  return Order.applyOrder(merged, order);
}

/** Raw merge without order (for order editing / export helpers). */
export async function loadMergedLinkCatalogUnordered() {
  const bundled = await loadBundledLinksJson();
  const overlay = await ensureLinksOverlay();
  return mergeLinksCatalog(bundled, overlay);
}

export async function getSectionOverlayChildren(sectionName) {
  const overlay = await ensureLinksOverlay();
  return overlay[sectionName]?.children || [];
}

export async function saveSectionOverlay(sectionName, section) {
  const overlay = await ensureLinksOverlay();
  overlay[sectionName] = section;
  await persistOverlay(overlay);
}

export async function saveSectionOverlayChildren(sectionName, children) {
  const overlay = await ensureLinksOverlay();
  overlay[sectionName] = {
    ...(overlay[sectionName] || {}),
    children,
  };
  await persistOverlay(overlay);
}

export async function addLinksToSection(sectionName, nodes) {
  const { ensureLinkId } = globalThis.SnLinksLinkCatalog;
  const children = await getSectionOverlayChildren(sectionName);
  await saveSectionOverlayChildren(
    sectionName,
    children.concat(nodes.map((node) => ensureLinkId(node)))
  );
}

export async function importLinksOverlay(raw) {
  const Order = globalThis.SnLinksCatalogOrder;
  const overlay = await ensureLinksOverlay();
  const result = importOverlayIntoExisting(overlay, raw);
  await persistOverlay(result.overlay, "import");
  const merged = mergeLinksCatalog(await loadBundledLinksJson(), result.overlay);
  const order = Order.appendMissingKeys(await Order.loadCatalogOrder(), merged);
  await Order.saveCatalogOrder(order);
  return result;
}

export async function findCustomLinkById(linkId) {
  const overlay = await ensureLinksOverlay();
  for (const [sectionName, section] of Object.entries(overlay)) {
    if (!Array.isArray(section?.children)) {
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
  await persistOverlay(overlay, "delete");
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

  await persistOverlay(overlay);
}

export async function getAllCustomLinks() {
  const Order = globalThis.SnLinksCatalogOrder;
  const overlay = await ensureLinksOverlay();
  const order = await Order.loadCatalogOrder();
  const orderIndex = new Map(
    (order.linkKeys || []).map((key, i) => [key, i])
  );
  const results = [];

  for (const [sectionName, section] of Object.entries(overlay)) {
    if (!Array.isArray(section?.children)) {
      continue;
    }
    for (const node of section.children) {
      if (node.id && !node.children) {
        const key = Order.linkStableKey(sectionName, [], node);
        results.push({
          ...node,
          sectionName,
          _orderRank: orderIndex.has(key)
            ? orderIndex.get(key)
            : Number.MAX_SAFE_INTEGER,
        });
      }
    }
  }

  return results
    .sort((a, b) => a._orderRank - b._orderRank)
    .map(({ _orderRank, ...link }) => link);
}

export async function getCatalogSectionNames() {
  const catalog = await loadMergedLinkCatalog();
  return Object.keys(catalog);
}

export async function getLinksOverlayForExport() {
  const Order = globalThis.SnLinksCatalogOrder;
  const overlay = await ensureLinksOverlay();
  const order = await Order.loadCatalogOrder();
  return Order.applyOrder(overlay, order);
}

/** @deprecated use addLinksToSection */
export async function addCustomLinks(
  nodes,
  sectionName = LEGACY_CUSTOM_MIGRATION_SECTION
) {
  await addLinksToSection(sectionName, nodes);
}
