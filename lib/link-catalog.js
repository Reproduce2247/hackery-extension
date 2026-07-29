(function () {
  const CUSTOM_SECTION_NAME = "Custom";
  const LEGACY_CUSTOM_MIGRATION_SECTION = "Misc";
  const HIDDEN_SECTION_TABS = new Set([CUSTOM_SECTION_NAME]);

  function isHiddenSectionTab(sectionName) {
    return HIDDEN_SECTION_TABS.has(sectionName);
  }

  function isCustomLink(node) {
    return Boolean(node?.id && !node.children);
  }

  function mergeLinksCatalog(bundled, overlay) {
    if (!overlay || typeof overlay !== "object") {
      return bundled;
    }

    const result = { ...bundled };
    for (const [sectionName, sectionOverlay] of Object.entries(overlay)) {
      if (!sectionOverlay || typeof sectionOverlay !== "object") {
        continue;
      }

      const base = result[sectionName] || { children: [] };
      const baseChildren = Array.isArray(base.children) ? base.children : [];
      const overlayChildren = Array.isArray(sectionOverlay.children)
        ? sectionOverlay.children
        : [];
      const { hostPattern: _overlayHost, children: _overlayChildren, ...sectionMeta } =
        sectionOverlay;

      result[sectionName] = {
        ...base,
        ...sectionMeta,
        ...(Object.prototype.hasOwnProperty.call(sectionOverlay, "hostPattern")
          ? { hostPattern: sectionOverlay.hostPattern }
          : {}),
        children: baseChildren.concat(overlayChildren),
      };
    }
    return result;
  }

  const EXPORTABLE_KEYS = [
    "id",
    "name",
    "displayName",
    "type",
    "code",
    "path",
    "url",
    "nav",
    "hostPattern",
    "parameter",
    "parameters",
    "extract",
    "searchTags",
  ];

  function serializeLinkNode(node) {
    if (node.children) {
      const folder = { name: node.name };
      if (Object.prototype.hasOwnProperty.call(node, "hostPattern")) {
        folder.hostPattern = node.hostPattern;
      }
      folder.children = node.children.map((child) => serializeLinkNode(child));
      return folder;
    }

    const out = {};
    for (const key of EXPORTABLE_KEYS) {
      if (
        key === "hostPattern" &&
        !Object.prototype.hasOwnProperty.call(node, "hostPattern")
      ) {
        continue;
      }
      const value = node[key];
      if (value === undefined || value === null) {
        continue;
      }
      if (key === "searchTags" && (!Array.isArray(value) || value.length === 0)) {
        continue;
      }
      if ((key === "code" || key === "path" || key === "url") && value === "") {
        continue;
      }
      out[key] = value;
    }
    return out;
  }

  function ensureLinkId(node) {
    if (node.children || node.id) {
      return node;
    }
    return { ...node, id: crypto.randomUUID() };
  }

  function migrateCustomScripts(scripts) {
    if (!Array.isArray(scripts) || scripts.length === 0) {
      return null;
    }

    return {
      [CUSTOM_SECTION_NAME]: {
        children: scripts.map((script) =>
          ensureLinkId({
            id: script.id,
            name: script.name,
            type: "scriptlet",
            code: script.code,
            ...(script.parameter ? { parameter: script.parameter } : {}),
            ...(script.parameters ? { parameters: script.parameters } : {}),
          })
        ),
      },
    };
  }

  function parseImportedLinkNodes(raw) {
    let data = raw;
    if (typeof raw === "string") {
      data = JSON.parse(raw);
    }

    if (Array.isArray(data)) {
      return data;
    }

    if (data && typeof data === "object") {
      if (data.type || data.code || data.path || data.url) {
        return [data];
      }
      if (data[CUSTOM_SECTION_NAME]?.children) {
        return data[CUSTOM_SECTION_NAME].children;
      }
      if (Array.isArray(data.children)) {
        return data.children;
      }
    }

    throw new Error(
      "Import JSON must be a link node, array of nodes, or Custom section."
    );
  }

  function validateImportNode(node, indexLabel) {
    if (!node || typeof node !== "object") {
      throw new Error(`Invalid node at ${indexLabel}.`);
    }

    if (node.children) {
      if (!node.name) {
        throw new Error(`Folder at ${indexLabel} needs a name.`);
      }
      node.children.forEach((child, index) =>
        validateImportNode(child, `${indexLabel}.${index}`)
      );
      return;
    }

    if (!node.name) {
      throw new Error(`Link at ${indexLabel} needs a name.`);
    }
    if (!node.type) {
      throw new Error(`Link "${node.name}" needs a type.`);
    }
    if (node.type === "scriptlet" && !node.code) {
      throw new Error(`Scriptlet "${node.name}" needs code.`);
    }
    if (node.type === "navigate" && !node.path) {
      throw new Error(`Navigate link "${node.name}" needs a path.`);
    }
    if (node.type === "derived-url" && !node.nav) {
      throw new Error(`Derived URL "${node.name}" needs nav.`);
    }
    if (node.type === "derived-url" && !node.path && !node.url) {
      throw new Error(`Derived URL "${node.name}" needs path or url.`);
    }
  }

  function normalizeImportedNodes(nodes) {
    return nodes.map((node) => {
      if (node.children) {
        return {
          ...node,
          children: normalizeImportedNodes(node.children),
        };
      }
      return ensureLinkId({ ...node });
    });
  }

  function overlayExport(overlay) {
    if (!overlay || typeof overlay !== "object") {
      return {};
    }

    const result = {};
    for (const [sectionName, section] of Object.entries(overlay)) {
      if (isHiddenSectionTab(sectionName) || !section?.children?.length) {
        continue;
      }
      result[sectionName] = {
        ...section,
        children: section.children.map((node) => serializeLinkNode(node)),
      };
    }
    return result;
  }

  function customSectionExport(overlay) {
    return overlayExport(overlay);
  }

  function migrateLegacyCustomSection(overlay) {
    if (!overlay[CUSTOM_SECTION_NAME]) {
      return overlay;
    }

    const legacySection = overlay[CUSTOM_SECTION_NAME];
    if (!legacySection?.children?.length) {
      const next = { ...overlay };
      delete next[CUSTOM_SECTION_NAME];
      return next;
    }

    const targetName = LEGACY_CUSTOM_MIGRATION_SECTION;
    const target = overlay[targetName] || { children: [] };
    const existingIds = new Set(
      (target.children || []).map((node) => node.id).filter(Boolean)
    );
    const toAdd = legacySection.children.filter(
      (node) => !node.id || !existingIds.has(node.id)
    );

    const next = { ...overlay };
    next[targetName] = {
      ...target,
      children: (target.children || []).concat(toAdd),
    };
    delete next[CUSTOM_SECTION_NAME];
    return next;
  }

  async function ensureLinksOverlayInStorage() {
    const { LINKS_OVERLAY_KEY, CUSTOM_SCRIPTS_KEY } = globalThis.SnLinksStorageKeys;
    const stored = await browser.storage.local.get([
      LINKS_OVERLAY_KEY,
      CUSTOM_SCRIPTS_KEY,
    ]);
    let overlay = stored[LINKS_OVERLAY_KEY];

    if (!overlay || typeof overlay !== "object") {
      overlay = {};
    }

    const legacyScripts = stored[CUSTOM_SCRIPTS_KEY];
    if (Array.isArray(legacyScripts) && legacyScripts.length > 0) {
      const migrated = migrateCustomScripts(legacyScripts);
      const targetName = LEGACY_CUSTOM_MIGRATION_SECTION;
      const existing = overlay[targetName]?.children || [];
      const existingIds = new Set(existing.map((node) => node.id).filter(Boolean));
      const toAdd = migrated[CUSTOM_SECTION_NAME].children.filter(
        (node) => !existingIds.has(node.id)
      );
      overlay = {
        ...overlay,
        [targetName]: {
          ...(overlay[targetName] || {}),
          children: existing.concat(toAdd),
        },
      };
      await browser.storage.local.set({ [LINKS_OVERLAY_KEY]: overlay });
      await browser.storage.local.remove(CUSTOM_SCRIPTS_KEY);
    }

    const migratedOverlay = migrateLegacyCustomSection(overlay);
    if (migratedOverlay !== overlay) {
      overlay = migratedOverlay;
      await browser.storage.local.set({ [LINKS_OVERLAY_KEY]: overlay });
    }

    return overlay;
  }

  const SnLinksLinkCatalog = {
    CUSTOM_SECTION_NAME,
    LEGACY_CUSTOM_MIGRATION_SECTION,
    isHiddenSectionTab,
    isCustomLink,
    mergeLinksCatalog,
    serializeLinkNode,
    ensureLinkId,
    migrateCustomScripts,
    parseImportedLinkNodes,
    validateImportNode,
    normalizeImportedNodes,
    overlayExport,
    customSectionExport,
    ensureLinksOverlayInStorage,
  };

  globalThis.SnLinksLinkCatalog = SnLinksLinkCatalog;
})();
