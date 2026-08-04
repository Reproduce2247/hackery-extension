import { MessageTypes } from "./message-types.js";
import { respondAsync } from "./message-router.js";

/**
 * @param {object} ctx
 * @param {string} ctx.INJECT_ON_LOAD_ENABLED_KEY
 * @param {Function} ctx.extensionSettings
 * @param {Function} ctx.codesForUrl
 * @param {Function} ctx.runInjectEntriesForTab
 * @param {Function} ctx.executeScriptletInTab
 * @param {Function} ctx.refreshInjectState
 * @param {Function} ctx.loadExtensionSettings
 * @param {Function} ctx.isCspDisabledForTab
 * @param {Function} ctx.setCspDisabledForTab
 * @param {Function} [ctx.collectNetworkSettingsPayload] optional hook so the
 *   network plugin can contribute keys to SET_EXTENSION_SETTINGS without a global.
 */
export function createBackgroundMessageHandlers(ctx) {
  const {
    INJECT_ON_LOAD_ENABLED_KEY,
    extensionSettings,
    codesForUrl,
    runInjectEntriesForTab,
    executeScriptletInTab,
    refreshInjectState,
    loadExtensionSettings,
    isCspDisabledForTab,
    setCspDisabledForTab,
    collectNetworkSettingsPayload,
  } = ctx;

  const T = MessageTypes;

  return {
    [T.RUN_SCRIPTLET](message, _sender, sendResponse) {
      respondAsync(
        executeScriptletInTab(
          message.tabId,
          message.code,
          message.paramValues || {},
          message.frameId
        ).then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    [T.RUN_INJECT_CODES](message, sender, sendResponse) {
      const tabId = sender.tab?.id;
      const frameId = sender.frameId;
      if (!tabId) {
        sendResponse({ ok: false, error: "Missing tab id." });
        return false;
      }
      if (!extensionSettings().injectOnLoadEnabled) {
        sendResponse({ ok: true });
        return false;
      }
      const entries = codesForUrl(message.url || "");
      respondAsync(
        runInjectEntriesForTab(tabId, entries, frameId).then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    [T.REFRESH_INJECT](_message, _sender, sendResponse) {
      respondAsync(refreshInjectState().then(() => ({ ok: true })), sendResponse);
      return true;
    },

    [T.GET_EXTENSION_SETTINGS](_message, _sender, sendResponse) {
      respondAsync(
        loadExtensionSettings().then((settings) => ({ ok: true, settings })),
        sendResponse
      );
      return true;
    },

    [T.SET_EXTENSION_SETTINGS](message, _sender, sendResponse) {
      const next = message.settings || {};
      const payload = {};
      if (typeof next.injectOnLoadEnabled === "boolean") {
        payload[INJECT_ON_LOAD_ENABLED_KEY] = next.injectOnLoadEnabled;
      }
      if (collectNetworkSettingsPayload) {
        Object.assign(payload, collectNetworkSettingsPayload(next));
      }
      respondAsync(
        browser.storage.local.set(payload).then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    [T.GET_CSP_DISABLED](message, _sender, sendResponse) {
      sendResponse({
        ok: true,
        disabled: isCspDisabledForTab(message.tabId),
      });
      return false;
    },

    [T.SET_CSP_DISABLED](message, _sender, sendResponse) {
      setCspDisabledForTab(message.tabId, Boolean(message.disabled));
      sendResponse({ ok: true });
      return false;
    },
  };
}
