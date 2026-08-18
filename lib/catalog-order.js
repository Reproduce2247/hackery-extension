/**
 * Stable link keys and user catalog order override (display + export).
 */
import { emitCatalogChanged } from "./catalog-events.js";
import { StorageKeys } from "./storage-keys.js";

const { CATALOG_ORDER_KEY } = StorageKeys;

/**
 * Stable key for shortcuts and ordering.
 * Prefer id; fall back to section/folder path/name for legacy nodes without one.
 */
export function linkStableKey(sectionName, pathParts, node) {
  if (node?.id) {
    return `id:${node.id}`;
  }
  const parts = [sectionName, ...(pathParts || []), node?.name || ""]
    .map((p) => String(p).replace(/\//g, "\\/"))
    .filter((p) => p !== "");
  return parts.join("/");
}

export function folderStableKey(sectionName, pathParts, folderName) {
  const parts = [sectionName, ...(pathParts || []), folderName || ""]
    .map((p) => String(p).replace(/\//g, "\\/"));
  return `folder:${parts.join("/")}`;
}

export function walkWithKeys(nodes, sectionName, pathParts, visitor) {
  for (const node of nodes || []) {
    if (node.children) {
      const key = folderStableKey(sectionName, pathParts, node.name);
      visitor({ kind: "folder", key, node, sectionName, pathParts });
      walkWithKeys(node.children, sectionName, [...pathParts, node.name], visitor);
      continue;
    }
    const key = linkStableKey(sectionName, pathParts, node);
    visitor({ kind: "leaf", key, node, sectionName, pathParts });
  }
}

export function collectKeysFromCatalog(catalog) {
  const keys = [];
  const sectionOrder = [];
  for (const [sectionName, section] of Object.entries(catalog || {})) {
    sectionOrder.push(sectionName);
    walkWithKeys(section.children || [], sectionName, [], (entry) => {
      keys.push(entry.key);
    });
  }
  return { keys, sectionOrder };
}

function sortChildrenByOrder(children, sectionName, pathParts, orderIndex) {
  if (!Array.isArray(children) || children.length === 0) {
    return children || [];
  }

  const withKeys = children.map((node) => {
    const key = node.children
      ? folderStableKey(sectionName, pathParts, node.name)
      : linkStableKey(sectionName, pathParts, node);
    return { node, key, rank: orderIndex.has(key) ? orderIndex.get(key) : Number.MAX_SAFE_INTEGER };
  });

  withKeys.sort((a, b) => {
    if (a.rank !== b.rank) {
      return a.rank - b.rank;
    }
    return 0;
  });

  return withKeys.map(({ node }) => {
    if (!node.children) {
      return node;
    }
    return {
      ...node,
      children: sortChildrenByOrder(
        node.children,
        sectionName,
        [...pathParts, node.name],
        orderIndex
      ),
    };
  });
}

/**
 * Apply stored order to a merged catalog. Unknown keys keep relative original order at end.
 */
export function applyOrder(catalog, orderState) {
  if (!catalog || typeof catalog !== "object") {
    return catalog;
  }

  const linkKeys = orderState?.linkKeys;
  const sectionOrder = orderState?.sectionOrder;
  const orderIndex = new Map();
  if (Array.isArray(linkKeys)) {
    linkKeys.forEach((key, i) => orderIndex.set(key, i));
  }

  let sectionNames = Object.keys(catalog);
  if (Array.isArray(sectionOrder) && sectionOrder.length) {
    const seen = new Set();
    const ordered = [];
    for (const name of sectionOrder) {
      if (catalog[name] && !seen.has(name)) {
        ordered.push(name);
        seen.add(name);
      }
    }
    for (const name of sectionNames) {
      if (!seen.has(name)) {
        ordered.push(name);
      }
    }
    sectionNames = ordered;
  }

  const result = {};
  for (const sectionName of sectionNames) {
    const section = catalog[sectionName];
    result[sectionName] = {
      ...section,
      children: sortChildrenByOrder(
        section.children || [],
        sectionName,
        [],
        orderIndex
      ),
    };
  }
  return result;
}

/**
 * Reorder siblings within a section/folder after DnD.
 * @param {string[]} orderedKeys sibling stable keys in new order
 */
export function moveKeysInOrder(linkKeys, orderedSiblingKeys) {
  const set = new Set(orderedSiblingKeys);
  const without = (linkKeys || []).filter((k) => !set.has(k));
  // Insert the sibling block at the position of the first sibling that existed before.
  let insertAt = without.length;
  for (let i = 0; i < (linkKeys || []).length; i++) {
    if (set.has(linkKeys[i])) {
      insertAt = without.findIndex(() => false); // placeholder
      // Count how many non-siblings appear before first sibling
      let before = 0;
      for (let j = 0; j < i; j++) {
        if (!set.has(linkKeys[j])) {
          before++;
        }
      }
      insertAt = before;
      break;
    }
  }
  const next = [...without];
  next.splice(insertAt, 0, ...orderedSiblingKeys);
  // Deduplicate while preserving order
  const seen = new Set();
  return next.filter((k) => {
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}

export async function loadCatalogOrder() {
  const stored = await browser.storage.local.get(CATALOG_ORDER_KEY);
  const raw = stored[CATALOG_ORDER_KEY];
  if (!raw || typeof raw !== "object") {
    return { linkKeys: [], sectionOrder: [] };
  }
  return {
    linkKeys: Array.isArray(raw.linkKeys) ? raw.linkKeys : [],
    sectionOrder: Array.isArray(raw.sectionOrder) ? raw.sectionOrder : [],
  };
}

export async function saveCatalogOrder(orderState) {
  await browser.storage.local.set({
    [CATALOG_ORDER_KEY]: {
      linkKeys: orderState.linkKeys || [],
      sectionOrder: orderState.sectionOrder || [],
    },
  });
  emitCatalogChanged({ reason: "order" });
}

/** Append any keys from catalog that are missing from the order list. */
export function appendMissingKeys(orderState, catalog) {
  const { keys, sectionOrder } = collectKeysFromCatalog(catalog);
  const existing = new Set(orderState.linkKeys || []);
  const linkKeys = [...(orderState.linkKeys || [])];
  for (const key of keys) {
    if (!existing.has(key)) {
      linkKeys.push(key);
      existing.add(key);
    }
  }
  let nextSections = orderState.sectionOrder || [];
  if (!nextSections.length) {
    nextSections = sectionOrder;
  } else {
    const seen = new Set(nextSections);
    for (const name of sectionOrder) {
      if (!seen.has(name)) {
        nextSections.push(name);
      }
    }
  }
  return { linkKeys, sectionOrder: nextSections };
}

export { CATALOG_ORDER_KEY };
