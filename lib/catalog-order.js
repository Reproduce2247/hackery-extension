/**
 * Stable link keys and user catalog order override (display + export).
 */
import { emitCatalogChanged } from "./catalog-events.js";
import { StorageKeys } from "./storage-keys.js";

const { CATALOG_ORDER_KEY } = StorageKeys;

const CATALOG_KEY = "__catalogKey";

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

export function nodeCatalogKey(node, sectionName, pathParts) {
  if (node?.[CATALOG_KEY]) {
    return node[CATALOG_KEY];
  }
  if (node?.children) {
    return folderStableKey(sectionName, pathParts, node.name);
  }
  return linkStableKey(sectionName, pathParts, node);
}

function stampCatalogKey(node, key) {
  Object.defineProperty(node, CATALOG_KEY, {
    value: key,
    enumerable: false,
    configurable: true,
  });
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

/**
 * Map of stable key → parent folder key (or null at section root) from JSON home.
 */
export function collectOriginParentMap(catalog) {
  const originParent = new Map();
  for (const [sectionName, section] of Object.entries(catalog || {})) {
    walkWithKeys(section.children || [], sectionName, [], (entry) => {
      const parentPath = entry.pathParts || [];
      const parentKey =
        parentPath.length === 0
          ? null
          : folderStableKey(
              sectionName,
              parentPath.slice(0, -1),
              parentPath[parentPath.length - 1]
            );
      originParent.set(entry.key, parentKey);
    });
  }
  return originParent;
}

export function normalizeParentByKey(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key || !value || typeof value !== "object") {
      continue;
    }
    const section = String(value.section || "").trim();
    if (!section) {
      continue;
    }
    const parentKey =
      value.parentKey == null || value.parentKey === ""
        ? null
        : String(value.parentKey);
    out[key] = { section, parentKey };
  }
  return out;
}

function emptyOrderState() {
  return { linkKeys: [], sectionOrder: [], parentByKey: {} };
}

export function normalizeOrderState(raw) {
  if (!raw || typeof raw !== "object") {
    return emptyOrderState();
  }
  return {
    linkKeys: Array.isArray(raw.linkKeys) ? raw.linkKeys : [],
    sectionOrder: Array.isArray(raw.sectionOrder) ? raw.sectionOrder : [],
    parentByKey: normalizeParentByKey(raw.parentByKey),
  };
}

function effectiveParentKey(key, parentByKey, originParent) {
  if (Object.prototype.hasOwnProperty.call(parentByKey, key)) {
    return parentByKey[key].parentKey;
  }
  return originParent.get(key) ?? null;
}

/**
 * True if placing `movingKey` under `destParentKey` would cycle.
 */
export function placementWouldCycle(
  movingKey,
  destParentKey,
  parentByKey,
  originParent
) {
  if (!destParentKey) {
    return false;
  }
  if (destParentKey === movingKey) {
    return true;
  }
  const nextParents = {
    ...parentByKey,
    [movingKey]: { section: "_", parentKey: destParentKey },
  };
  const seen = new Set([movingKey]);
  let current = destParentKey;
  while (current) {
    if (seen.has(current)) {
      return true;
    }
    seen.add(current);
    current = effectiveParentKey(current, nextParents, originParent);
  }
  return false;
}

function cloneNodes(nodes) {
  return (nodes || []).map((node) => {
    if (node?.children) {
      return { ...node, children: cloneNodes(node.children) };
    }
    return { ...node };
  });
}

function cloneCatalog(catalog) {
  const result = {};
  for (const [sectionName, section] of Object.entries(catalog || {})) {
    result[sectionName] = {
      ...section,
      children: cloneNodes(section.children || []),
    };
  }
  return result;
}

function indexClonedCatalog(catalog) {
  const byKey = new Map();
  const originParent = new Map();

  const walk = (nodes, sectionName, pathParts, parentKey, parentList) => {
    for (const node of nodes) {
      const key = node.children
        ? folderStableKey(sectionName, pathParts, node.name)
        : linkStableKey(sectionName, pathParts, node);
      stampCatalogKey(node, key);
      byKey.set(key, {
        node,
        parentList,
        parentKey,
        sectionName,
      });
      originParent.set(key, parentKey);
      if (node.children) {
        walk(
          node.children,
          sectionName,
          [...pathParts, node.name],
          key,
          node.children
        );
      }
    }
  };

  for (const [sectionName, section] of Object.entries(catalog || {})) {
    if (!Array.isArray(section.children)) {
      section.children = [];
    }
    walk(section.children, sectionName, [], null, section.children);
  }
  return { byKey, originParent };
}

function sortChildrenInPlace(children, orderIndex, keyOfNode) {
  if (!Array.isArray(children) || children.length < 2) {
    for (const node of children || []) {
      if (node?.children) {
        sortChildrenInPlace(node.children, orderIndex, keyOfNode);
      }
    }
    return children || [];
  }

  children.sort((a, b) => {
    const keyA = keyOfNode.get(a);
    const keyB = keyOfNode.get(b);
    const rankA = orderIndex.has(keyA) ? orderIndex.get(keyA) : Number.MAX_SAFE_INTEGER;
    const rankB = orderIndex.has(keyB) ? orderIndex.get(keyB) : Number.MAX_SAFE_INTEGER;
    return rankA - rankB;
  });

  for (const node of children) {
    if (node?.children) {
      sortChildrenInPlace(node.children, orderIndex, keyOfNode);
    }
  }
  return children;
}

function applyParentPlacements(catalog, parentByKey) {
  const { byKey, originParent } = indexClonedCatalog(catalog);
  const moves = [];
  for (const [key, placement] of Object.entries(parentByKey)) {
    const entry = byKey.get(key);
    if (!entry || !placement) {
      continue;
    }
    if (placementWouldCycle(key, placement.parentKey, parentByKey, originParent)) {
      continue;
    }
    if (placement.parentKey != null) {
      const destEntry = byKey.get(placement.parentKey);
      if (!destEntry?.node?.children) {
        continue;
      }
    } else if (!placement.section) {
      continue;
    }
    moves.push({ key, placement, entry });
  }

  for (const { entry } of moves) {
    const index = entry.parentList.indexOf(entry.node);
    if (index >= 0) {
      entry.parentList.splice(index, 1);
    }
  }

  for (const { key, placement, entry } of moves) {
    let destList;
    if (placement.parentKey == null) {
      if (!catalog[placement.section]) {
        catalog[placement.section] = { children: [] };
      }
      if (!Array.isArray(catalog[placement.section].children)) {
        catalog[placement.section].children = [];
      }
      destList = catalog[placement.section].children;
    } else {
      const destEntry = byKey.get(placement.parentKey);
      if (!destEntry?.node?.children) {
        continue;
      }
      destList = destEntry.node.children;
    }
    destList.push(entry.node);
    entry.parentList = destList;
    entry.parentKey = placement.parentKey;
    entry.sectionName = placement.section;
    byKey.set(key, entry);
  }

  const keyOfNode = new Map();
  for (const [key, value] of byKey) {
    keyOfNode.set(value.node, key);
  }
  return keyOfNode;
}

/**
 * Apply stored order to a merged catalog. Unknown keys keep relative original order at end.
 */
export function applyOrder(catalog, orderState) {
  if (!catalog || typeof catalog !== "object") {
    return catalog;
  }

  const normalized = normalizeOrderState(orderState);
  const cloned = cloneCatalog(catalog);
  const keyOfNode = applyParentPlacements(cloned, normalized.parentByKey);

  const orderIndex = new Map();
  normalized.linkKeys.forEach((key, i) => orderIndex.set(key, i));

  let sectionNames = Object.keys(cloned);
  if (normalized.sectionOrder.length) {
    const seen = new Set();
    const ordered = [];
    for (const name of normalized.sectionOrder) {
      if (cloned[name] && !seen.has(name)) {
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
    const section = cloned[sectionName];
    sortChildrenInPlace(section.children || [], orderIndex, keyOfNode);
    result[sectionName] = section;
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
  let insertAt = without.length;
  for (let i = 0; i < (linkKeys || []).length; i++) {
    if (set.has(linkKeys[i])) {
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
  return normalizeOrderState(stored[CATALOG_ORDER_KEY]);
}

export async function saveCatalogOrder(orderState) {
  const normalized = normalizeOrderState(orderState);
  await browser.storage.local.set({
    [CATALOG_ORDER_KEY]: normalized,
  });
  emitCatalogChanged({ reason: "order" });
}

/** Append any keys from catalog that are missing from the order list. */
export function appendMissingKeys(orderState, catalog) {
  const normalized = normalizeOrderState(orderState);
  const { keys, sectionOrder } = collectKeysFromCatalog(catalog);
  const existing = new Set(normalized.linkKeys);
  const linkKeys = [...normalized.linkKeys];
  for (const key of keys) {
    if (!existing.has(key)) {
      linkKeys.push(key);
      existing.add(key);
    }
  }
  let nextSections = normalized.sectionOrder;
  if (!nextSections.length) {
    nextSections = sectionOrder;
  } else {
    const seen = new Set(nextSections);
    nextSections = [...nextSections];
    for (const name of sectionOrder) {
      if (!seen.has(name)) {
        nextSections.push(name);
        seen.add(name);
      }
    }
  }
  return {
    linkKeys,
    sectionOrder: nextSections,
    parentByKey: normalized.parentByKey,
  };
}

export { CATALOG_ORDER_KEY };
