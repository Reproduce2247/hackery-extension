(function () {
  const LEGACY_CUSTOM_SECTION_NAME = "Custom";
  const LEGACY_CUSTOM_MIGRATION_SECTION = "Misc";

  const EXPORTABLE_LINK_KEYS = [
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

  const EXPORTABLE_SECTION_KEYS = ["hostPattern"];

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
    for (const key of EXPORTABLE_LINK_KEYS) {
      if (key === "hostPattern") {
        if (Object.prototype.hasOwnProperty.call(node, "hostPattern")) {
          out.hostPattern = node.hostPattern;
        }
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

  function serializeSection(section) {
    const out = {};
    for (const key of EXPORTABLE_SECTION_KEYS) {
      if (Object.prototype.hasOwnProperty.call(section, key)) {
        out[key] = section[key];
      }
    }
    out.children = (section?.children || []).map((node) => serializeLinkNode(node));
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
      [LEGACY_CUSTOM_MIGRATION_SECTION]: {
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

  function isSectionOverlay(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return false;
    }
    if (data.type || data.code || data.path || data.url) {
      return false;
    }
    if (Array.isArray(data.children)) {
      return false;
    }

    const entries = Object.entries(data);
    if (!entries.length) {
      return false;
    }

    return entries.every(
      ([, section]) =>
        section &&
        typeof section === "object" &&
        Array.isArray(section.children)
    );
  }

  function parseImportOverlay(raw) {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!isSectionOverlay(data)) {
      throw new Error(
        'Import JSON must be a section overlay: { "SectionName": { "children": [...] } }'
      );
    }
    return data;
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

  function countOverlayLeaves(nodes) {
    let count = 0;
    for (const node of nodes || []) {
      if (node.children) {
        count += countOverlayLeaves(node.children);
      } else {
        count += 1;
      }
    }
    return count;
  }

  function findCustomLeafIndex(nodes, importedNode) {
    if (importedNode.id) {
      const byId = nodes.findIndex(
        (node) => !node.children && node.id === importedNode.id
      );
      if (byId !== -1) {
        return byId;
      }
    }

    return nodes.findIndex(
      (node) => !node.children && node.id && node.name === importedNode.name
    );
  }

  function mergeOverlayChildren(existingChildren, importedChildren) {
    const result = existingChildren.slice();

    for (const importedNode of importedChildren) {
      if (importedNode.children) {
        const folderIndex = result.findIndex(
          (node) => node.children && node.name === importedNode.name
        );
        if (folderIndex !== -1) {
          const existingFolder = result[folderIndex];
          result[folderIndex] = {
            ...existingFolder,
            ...(Object.prototype.hasOwnProperty.call(importedNode, "hostPattern")
              ? { hostPattern: importedNode.hostPattern }
              : {}),
            children: mergeOverlayChildren(
              existingFolder.children || [],
              importedNode.children
            ),
          };
        } else {
          result.push(normalizeImportedNodes([importedNode])[0]);
        }
        continue;
      }

      const replaceIndex = findCustomLeafIndex(result, importedNode);
      if (replaceIndex !== -1) {
        const existing = result[replaceIndex];
        result[replaceIndex] = {
          ...importedNode,
          id: existing.id,
        };
      } else {
        result.push(ensureLinkId(importedNode));
      }
    }

    return result;
  }

  function mergeSectionOverlay(existingSection, importedSection) {
    const existingChildren = Array.isArray(existingSection?.children)
      ? existingSection.children
      : [];
    const importedChildren = Array.isArray(importedSection?.children)
      ? importedSection.children
      : [];

    const merged = { ...(existingSection || {}) };

    for (const key of EXPORTABLE_SECTION_KEYS) {
      if (Object.prototype.hasOwnProperty.call(importedSection || {}, key)) {
        merged[key] = importedSection[key];
      }
    }

    merged.children = mergeOverlayChildren(existingChildren, importedChildren);
    return merged;
  }

  function normalizeImportSectionEntries(importedOverlay) {
    const mergedEntries = new Map();

    for (const [sectionName, section] of Object.entries(importedOverlay)) {
      const targetName =
        sectionName === LEGACY_CUSTOM_SECTION_NAME
          ? LEGACY_CUSTOM_MIGRATION_SECTION
          : sectionName;
      const existing = mergedEntries.get(targetName);
      mergedEntries.set(
        targetName,
        existing ? mergeSectionOverlay(existing, section) : section
      );
    }

    return mergedEntries;
  }

  function importOverlayIntoExisting(existingOverlay, raw) {
    const importedOverlay = parseImportOverlay(raw);
    const overlay = { ...(existingOverlay || {}) };
    const sectionNames = [];
    let importedLeafCount = 0;

    for (const [sectionName, section] of normalizeImportSectionEntries(
      importedOverlay
    )) {
      (section.children || []).forEach((node, index) =>
        validateImportNode(node, `${sectionName}.${index}`)
      );

      importedLeafCount += countOverlayLeaves(section.children);
      overlay[sectionName] = mergeSectionOverlay(overlay[sectionName], section);
      sectionNames.push(sectionName);
    }

    if (!importedLeafCount) {
      throw new Error("No links found in file.");
    }

    return {
      overlay,
      importedLeafCount,
      sectionNames,
    };
  }

  function overlayExport(overlay) {
    if (!overlay || typeof overlay !== "object") {
      return {};
    }

    const result = {};
    for (const [sectionName, section] of Object.entries(overlay)) {
      if (!section?.children?.length) {
        continue;
      }
      result[sectionName] = serializeSection(section);
    }
    return result;
  }

  function migrateLegacyCustomSection(overlay) {
    if (!overlay[LEGACY_CUSTOM_SECTION_NAME]) {
      return overlay;
    }

    const legacySection = overlay[LEGACY_CUSTOM_SECTION_NAME];
    if (!legacySection?.children?.length) {
      const next = { ...overlay };
      delete next[LEGACY_CUSTOM_SECTION_NAME];
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
    delete next[LEGACY_CUSTOM_SECTION_NAME];
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
      const toAdd = migrated[targetName].children.filter(
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
    LEGACY_CUSTOM_MIGRATION_SECTION,
    isCustomLink,
    mergeLinksCatalog,
    serializeLinkNode,
    serializeSection,
    ensureLinkId,
    migrateCustomScripts,
    isSectionOverlay,
    parseImportOverlay,
    validateImportNode,
    normalizeImportedNodes,
    importOverlayIntoExisting,
    overlayExport,
    ensureLinksOverlayInStorage,
  };

  globalThis.SnLinksLinkCatalog = SnLinksLinkCatalog;
})();
