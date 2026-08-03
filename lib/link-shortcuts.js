/**
 * Assignable Alt+1…Alt+0 shortcut slots → stable link keys.
 */
(function () {
  const LINK_SHORTCUT_SLOTS_KEY = "linkShortcutSlots";

  const SLOT_COMMANDS = [
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

  const SLOT_LABELS = {
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

  function isSlotCommand(name) {
    return SLOT_COMMANDS.includes(name);
  }

  async function loadShortcutSlots() {
    const stored = await browser.storage.local.get(LINK_SHORTCUT_SLOTS_KEY);
    const map = stored[LINK_SHORTCUT_SLOTS_KEY];
    return map && typeof map === "object" ? { ...map } : {};
  }

  async function saveShortcutSlots(map) {
    await browser.storage.local.set({ [LINK_SHORTCUT_SLOTS_KEY]: map || {} });
    globalThis.SnLinksCatalogEvents?.emitCatalogChanged?.({
      reason: "shortcuts",
    });
  }

  async function assignSlot(commandName, stableKey) {
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

  function slotForKey(map, stableKey) {
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
  function findNodeByStableKey(catalog, stableKey) {
    if (!stableKey || !catalog) {
      return null;
    }
    const Order = globalThis.SnLinksCatalogOrder;
    const LM = globalThis.SnLinksLinkModel;

    for (const [sectionName, section] of Object.entries(catalog)) {
      let matchedEntry = null;
      Order.walkWithKeys(section.children || [], sectionName, [], (entry) => {
        if (entry.kind === "leaf" && entry.key === stableKey) {
          matchedEntry = entry;
        }
      });
      if (!matchedEntry) {
        continue;
      }
      const leaves = LM.flattenLinkNodes(
        section.children || [],
        section.match ?? null,
        sectionName
      );
      if (stableKey.startsWith("id:")) {
        const id = stableKey.slice(3);
        return leaves.find((n) => n.id === id) || null;
      }
      // Match leaf that produces the same stable key under the same path.
      const pathParts = matchedEntry.pathParts || [];
      return (
        leaves.find(
          (n) =>
            Order.linkStableKey(sectionName, pathParts, n) === stableKey ||
            n.name === matchedEntry.node.name
        ) || null
      );
    }
    return null;
  }

  globalThis.SnLinksLinkShortcuts = {
    LINK_SHORTCUT_SLOTS_KEY,
    SLOT_COMMANDS,
    SLOT_LABELS,
    isSlotCommand,
    loadShortcutSlots,
    saveShortcutSlots,
    assignSlot,
    slotForKey,
    findNodeByStableKey,
  };
})();
