const assert = require("node:assert/strict");

/**
 * Regression tests for custom-link deletion.
 *
 * A leaf carries an `id` whether it lives in the bundled catalog or in the
 * overlay, so id presence alone must not decide whether the sidebar offers a
 * Remove button — only overlay membership can, and a delete that cannot find
 * its target must fail loudly instead of silently re-rendering.
 */

const BUNDLED = {
  Misc: {
    children: [
      { name: "Bundled plain", url: "https://example.com/a", open: "tab" },
      {
        id: "bundled-with-id",
        name: "Bundled with id",
        url: "https://example.com/b",
        open: "tab",
      },
    ],
  },
};

function installExtensionGlobals() {
  const store = {
    linksSchemaVersion: 3,
    linksJsonOverlay: {
      Misc: {
        children: [
          { id: "custom-top", name: "Custom top", code: "console.log(1)" },
          {
            name: "Folder",
            children: [
              {
                id: "custom-nested",
                name: "Custom nested",
                code: "console.log(2)",
              },
            ],
          },
        ],
      },
    },
  };

  globalThis.browser = {
    storage: {
      local: {
        async get(keys) {
          const names = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const name of names) {
            if (name in store) {
              out[name] = structuredClone(store[name]);
            }
          }
          return out;
        },
        async set(values) {
          for (const [name, value] of Object.entries(values)) {
            store[name] = structuredClone(value);
          }
        },
        async remove(name) {
          delete store[name];
        },
      },
    },
    runtime: {
      getURL: (path) => path,
      sendMessage: async () => {},
    },
  };

  globalThis.fetch = async () => ({ json: async () => structuredClone(BUNDLED) });

  return store;
}

function sectionLeafIds(catalog, sectionName) {
  const ids = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.children) {
        walk(node.children);
        continue;
      }
      if (node.id) {
        ids.push(node.id);
      }
    }
  };
  walk(catalog[sectionName]?.children);
  return ids;
}

async function run() {
  installExtensionGlobals();

  const {
    collectOverlayCustomLinkIds,
    loadMergedLinkCatalog,
    removeCustomLinkById,
  } = await import("../sidebar/link-storage.js");
  const { linkStableKey, loadCatalogOrder, moveKeysInOrder, saveCatalogOrder } =
    await import("../lib/catalog-order.js");

  const { isOverlayCustomLink, ensureLinkIdsInTree } = await import(
    "../lib/link-catalog.js"
  );

  const backfill = ensureLinkIdsInTree([
    { name: "No id yet", code: "1" },
    {
      name: "Folder",
      children: [{ name: "Nested no id", code: "2" }, { id: "keep-me", name: "Has id", code: "3" }],
    },
  ]);
  assert.equal(backfill.changed, true);
  assert.ok(backfill.nodes[0].id, "leaf without id gets one");
  assert.ok(backfill.nodes[1].children[0].id, "nested leaf without id gets one");
  assert.equal(backfill.nodes[1].children[1].id, "keep-me");
  assert.equal(
    ensureLinkIdsInTree(backfill.nodes).changed,
    false,
    "second pass is a no-op"
  );

  const overlayIds = await collectOverlayCustomLinkIds();
  assert.ok(
    overlayIds.has("custom-top") && overlayIds.has("custom-nested"),
    "overlay links (including nested ones) count as custom"
  );
  assert.ok(
    !overlayIds.has("bundled-with-id"),
    "a bundled leaf with an id is not a custom link"
  );

  // The sidebar only renders Remove/Edit for links this predicate accepts.
  const rendered = (await loadMergedLinkCatalog()).Misc.children;
  assert.deepEqual(
    rendered
      .filter((node) => isOverlayCustomLink(node, overlayIds))
      .map((node) => node.id),
    ["custom-top"],
    "only overlay links may be offered for removal"
  );

  // Drag the custom link to the top of the section, then delete it.
  const order = await loadCatalogOrder();
  const customKey = linkStableKey("Misc", [], { id: "custom-top" });
  const reordered = [
    customKey,
    ...order.linkKeys.filter((key) => key !== customKey),
  ];
  await saveCatalogOrder({
    linkKeys: moveKeysInOrder(order.linkKeys, reordered),
    sectionOrder: order.sectionOrder,
  });

  await removeCustomLinkById("custom-top");
  assert.ok(
    !sectionLeafIds(await loadMergedLinkCatalog(), "Misc").includes("custom-top"),
    "reordering a custom link must not break deleting it"
  );

  await removeCustomLinkById("custom-nested");
  assert.ok(
    !sectionLeafIds(await loadMergedLinkCatalog(), "Misc").includes(
      "custom-nested"
    ),
    "a custom link inside an overlay folder must be deletable"
  );

  await assert.rejects(
    () => removeCustomLinkById("bundled-with-id"),
    /not found/i,
    "deleting a bundled leaf must report failure, not no-op"
  );

  console.log("link storage: OK");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
