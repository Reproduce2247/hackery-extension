/**
 * Typed catalog-change broadcast for sidebar, inject cache, badge, omnibox.
 */
(function () {
  const CATALOG_CHANGED = "CATALOG_CHANGED";

  function emitCatalogChanged(detail = {}) {
    const message = {
      type: CATALOG_CHANGED,
      reason: detail.reason || "update",
      at: Date.now(),
      ...detail,
    };
    try {
      browser.runtime.sendMessage(message).catch(() => {});
    } catch {
      // No receiver yet (startup) is fine.
    }
    return message;
  }

  function isCatalogChangedMessage(message) {
    return message && message.type === CATALOG_CHANGED;
  }

  globalThis.SnLinksCatalogEvents = {
    CATALOG_CHANGED,
    emitCatalogChanged,
    isCatalogChangedMessage,
  };
})();
