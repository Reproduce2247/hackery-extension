import { emitCatalogChanged } from "../lib/catalog-events.js";
import {
  appendMissingKeys,
  applyOrder,
  CATALOG_ORDER_KEY,
  linkStableKey,
  loadCatalogOrder,
  saveCatalogOrder,
} from "../lib/catalog-order.js";
import {
  ensureLinkId,
  ensureLinksOverlayInStorage,
  importOverlayIntoExisting,
  LEGACY_CUSTOM_MIGRATION_SECTION,
  mergeLinksCatalog,
} from "../lib/link-catalog.js";
import { StorageKeys } from "../lib/storage-keys.js";

const { LINKS_OVERLAY_KEY } = StorageKeys;

async function persistOverlay(overlay, reason = "overlay") {
  await browser.storage.local.set({ [LINKS_OVERLAY_KEY]: overlay });
  emitCatalogChanged({ reason });
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
  const bundled = await loadBundledLinksJson();
  const overlay = await ensureLinksOverlay();
  const merged = mergeLinksCatalog(bundled, overlay);
  let order = await loadCatalogOrder();
  const next = appendMissingKeys(order, merged);
  if (
    next.linkKeys.length !== order.linkKeys.length ||
    next.sectionOrder.length !== order.sectionOrder.length
  ) {
    order = next;
    await browser.storage.local.set({ [CATALOG_ORDER_KEY]: order });
  }
  return applyOrder(merged, order);
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
  const children = await getSectionOverlayChildren(sectionName);
  await saveSectionOverlayChildren(
    sectionName,
    children.concat(nodes.map((node) => ensureLinkId(node)))
  );
}

export async function importLinksOverlay(raw) {
  const overlay = await ensureLinksOverlay();
  const result = importOverlayIntoExisting(overlay, raw);
  await persistOverlay(result.overlay, "import");
  const merged = mergeLinksCatalog(await loadBundledLinksJson(), result.overlay);
  const order = appendMissingKeys(await loadCatalogOrder(), merged);
  await saveCatalogOrder(order);
  return result;
}

/**
 * Locate a custom leaf inside an overlay section, including inside folders.
 * Returns the live `children` array that holds it so callers can splice in place.
 * @returns {{ siblings: object[], index: number, node: object } | null}
 */
function locateCustomLeaf(children, linkId) {
  if (!Array.isArray(children)) {
    return null;
  }
  for (let index = 0; index < children.length; index++) {
    const node = children[index];
    if (node?.children) {
      const nested = locateCustomLeaf(node.children, linkId);
      if (nested) {
        return nested;
      }
      continue;
    }
    if (node?.id === linkId) {
      return { siblings: children, index, node };
    }
  }
  return null;
}

/**
 * @returns {{ overlay: object, sectionName: string, siblings: object[], index: number, node: object } | null}
 */
async function locateCustomLinkInOverlay(linkId) {
  const overlay = await ensureLinksOverlay();
  for (const [sectionName, section] of Object.entries(overlay)) {
    const found = locateCustomLeaf(section?.children, linkId);
    if (found) {
      return { overlay, sectionName, ...found };
    }
  }
  return null;
}

/** Ids of every leaf stored in the overlay — the links a user can edit or remove. */
export async function collectOverlayCustomLinkIds() {
  const overlay = await ensureLinksOverlay();
  const ids = new Set();
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node?.children) {
        walk(node.children);
        continue;
      }
      if (node?.id) {
        ids.add(node.id);
      }
    }
  };
  for (const section of Object.values(overlay)) {
    walk(section?.children);
  }
  return ids;
}

export async function findCustomLinkById(linkId) {
  const found = await locateCustomLinkInOverlay(linkId);
  if (!found) {
    return null;
  }
  return { sectionName: found.sectionName, index: found.index, node: found.node };
}

export async function removeCustomLinkById(linkId) {
  const found = await locateCustomLinkInOverlay(linkId);
  if (!found) {
    throw new Error("Custom link not found. Bundled links are edited in data/links.json.");
  }

  found.siblings.splice(found.index, 1);
  await persistOverlay(found.overlay, "delete");
}

export async function updateCustomLink(linkId, nextNode, targetSectionName) {
  const found = await locateCustomLinkInOverlay(linkId);
  if (!found) {
    throw new Error("Custom link not found.");
  }

  const { overlay } = found;
  const node = { ...nextNode, id: linkId };
  const sectionName = targetSectionName || found.sectionName;

  if (sectionName === found.sectionName) {
    found.siblings[found.index] = node;
  } else {
    found.siblings.splice(found.index, 1);
    overlay[sectionName] = {
      ...(overlay[sectionName] || {}),
      children: (overlay[sectionName]?.children || []).concat(node),
    };
  }

  await persistOverlay(overlay);
}

export async function getAllCustomLinks() {
  const overlay = await ensureLinksOverlay();
  const order = await loadCatalogOrder();
  const orderIndex = new Map(
    (order.linkKeys || []).map((key, i) => [key, i])
  );
  const results = [];

  const collect = (nodes, sectionName) => {
    for (const node of nodes || []) {
      if (node?.children) {
        collect(node.children, sectionName);
        continue;
      }
      if (!node?.id) {
        continue;
      }
      // Custom links key off their id, so folder depth does not affect the rank.
      const key = linkStableKey(sectionName, [], node);
      results.push({
        ...node,
        sectionName,
        _orderRank: orderIndex.has(key)
          ? orderIndex.get(key)
          : Number.MAX_SAFE_INTEGER,
      });
    }
  };

  for (const [sectionName, section] of Object.entries(overlay)) {
    collect(section?.children, sectionName);
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
  const overlay = await ensureLinksOverlay();
  const order = await loadCatalogOrder();
  return applyOrder(overlay, order);
}

/** @deprecated use addLinksToSection */
export async function addCustomLinks(
  nodes,
  sectionName = LEGACY_CUSTOM_MIGRATION_SECTION
) {
  await addLinksToSection(sectionName, nodes);
}
