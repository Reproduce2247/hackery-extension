/**
 * Assignable Alt+1…Alt+0 shortcut slots → stable link keys.
 */
import { emitCatalogChanged } from "./catalog-events.js";
import { linkStableKey } from "./catalog-order.js";
import { resolveMatch } from "./link-model.js";
import { StorageKeys } from "./storage-keys.js";

const { LINK_SHORTCUT_SLOTS_KEY } = StorageKeys;

export const SLOT_COMMANDS = [
  "run_link_1",
  "run_link_2",
  "run_link_3",
  "run_link_4",
  "run_link_5",
  "run_link_6",
  "run_link_7",
  "run_link_8",
  "run_link_9",
  "run_link_0",
];

export const SLOT_LABELS = {
  run_link_1: "1",
  run_link_2: "2",
  run_link_3: "3",
  run_link_4: "4",
  run_link_5: "5",
  run_link_6: "6",
  run_link_7: "7",
  run_link_8: "8",
  run_link_9: "9",
  run_link_0: "0",
};

export function isSlotCommand(name) {
  return SLOT_COMMANDS.includes(name);
}

export async function loadShortcutSlots() {
  const stored = await browser.storage.local.get(LINK_SHORTCUT_SLOTS_KEY);
  const map = stored[LINK_SHORTCUT_SLOTS_KEY];
  return map && typeof map === "object" ? { ...map } : {};
}

export async function saveShortcutSlots(map) {
  await browser.storage.local.set({ [LINK_SHORTCUT_SLOTS_KEY]: map || {} });
  emitCatalogChanged({ reason: "shortcuts" });
}

export async function assignSlot(commandName, stableKey) {
  const map = await loadShortcutSlots();
  for (const cmd of SLOT_COMMANDS) {
    if (map[cmd] === stableKey) {
      delete map[cmd];
    }
  }
  if (stableKey) {
    map[commandName] = stableKey;
  } else {
    delete map[commandName];
  }
  await saveShortcutSlots(map);
  return map;
}

export function slotForKey(map, stableKey) {
  for (const cmd of SLOT_COMMANDS) {
    if (map[cmd] === stableKey) {
      return cmd;
    }
  }
  return null;
}

/**
 * Resolve a stable key to a flattened leaf (with inherited match + sectionName).
 */
export function findNodeByStableKey(catalog, stableKey) {
  if (!stableKey || !catalog) {
    return null;
  }

  for (const [sectionName, section] of Object.entries(catalog)) {
    let found = null;
    (function visit(nodes, pathParts, inheritedMatch) {
      for (const node of nodes || []) {
        const match = resolveMatch(node, inheritedMatch);
        if (node.children) {
          visit(node.children, [...pathParts, node.name], match);
          continue;
        }
        if (linkStableKey(sectionName, pathParts, node) === stableKey) {
          found = { ...node, match, sectionName };
        }
      }
    })(
      section.children || [],
      [],
      section.match ?? section.hostPattern ?? null
    );
    if (found) {
      return found;
    }
  }
  return null;
}

export { LINK_SHORTCUT_SLOTS_KEY };
