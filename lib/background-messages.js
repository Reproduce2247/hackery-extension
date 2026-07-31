function createBackgroundMessageHandlers(ctx) {
  const {
    INJECT_ON_LOAD_KEY,
    PARAM_VALUES_KEY,
    CUSTOM_SCRIPTS_KEY,
    NETWORK_RULES_KEY,
    NETWORK_RULES_LOG_KEY,
    NETWORK_HOOKS_ENABLED_KEY,
    INJECT_ON_LOAD_ENABLED_KEY,
    extensionSettings,
    codesForUrl,
    executeScriptletInTab,
    refreshInjectState,
    loadExtensionSettings,
    loadNetworkTabState,
    installNetworkHookInTab,
    refreshNetworkRulesState,
    reinjectNetworkHookAllTabs,
    loadNetworkRulesState,
    appendNetworkRuleLog,
    persistSharedState,
    pageHookRules,
    defaultNetworkRulesState,
    isCspDisabledForTab,
    setCspDisabledForTab,
    startTestRuleSession,
  } = ctx;

  return {
    RUN_SCRIPTLET(message, _sender, sendResponse) {
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

    RUN_INJECT_CODES(message, sender, sendResponse) {
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

    REFRESH_INJECT(_message, _sender, sendResponse) {
      respondAsync(refreshInjectState().then(() => ({ ok: true })), sendResponse);
      return true;
    },

    GET_EXTENSION_SETTINGS(_message, _sender, sendResponse) {
      respondAsync(
        loadExtensionSettings().then((settings) => ({ ok: true, settings })),
        sendResponse
      );
      return true;
    },

    SET_EXTENSION_SETTINGS(message, _sender, sendResponse) {
      const next = message.settings || {};
      const payload = {};
      if (typeof next.networkHooksEnabled === "boolean") {
        payload[NETWORK_HOOKS_ENABLED_KEY] = next.networkHooksEnabled;
      }
      if (typeof next.injectOnLoadEnabled === "boolean") {
        payload[INJECT_ON_LOAD_ENABLED_KEY] = next.injectOnLoadEnabled;
      }
      respondAsync(
        browser.storage.local.set(payload).then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    INSTALL_NETWORK_HOOK(_message, sender, sendResponse) {
      const tabId = sender.tab?.id;
      const frameId = sender.frameId;
      if (!tabId) {
        sendResponse({ ok: false, error: "Missing tab id." });
        return false;
      }
      if (!pageHookRules().length) {
        sendResponse({ ok: true });
        return false;
      }
      respondAsync(
        (async () => {
          await loadNetworkTabState();
          await installNetworkHookInTab(tabId, frameId);
          return { ok: true };
        })(),
        sendResponse
      );
      return true;
    },

    REFRESH_NETWORK_RULES(_message, _sender, sendResponse) {
      respondAsync(
        refreshNetworkRulesState()
          .then(() => reinjectNetworkHookAllTabs())
          .then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    GET_NETWORK_RULES(_message, _sender, sendResponse) {
      respondAsync(
        loadNetworkRulesState().then((state) => ({ ok: true, state })),
        sendResponse
      );
      return true;
    },

    SAVE_NETWORK_RULES(message, _sender, sendResponse) {
      const nextState = message.state || defaultNetworkRulesState();
      if (!Array.isArray(nextState.rules)) {
        nextState.rules = [];
      }
      respondAsync(
        browser.storage.local
          .set({ [NETWORK_RULES_KEY]: nextState })
          .then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    NETWORK_RULE_LOG(message, sender, sendResponse) {
      respondAsync(
        appendNetworkRuleLog(message.entry, sender.tab?.id).then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    NETWORK_SHARED_STATE(message, sender, sendResponse) {
      const tabId = sender.tab?.id;
      respondAsync(
        (async () => {
          await persistSharedState(message.persistent, message.tab, tabId);
          if (tabId != null) {
            await loadNetworkTabState();
            await installNetworkHookInTab(tabId);
          }
          return { ok: true };
        })(),
        sendResponse
      );
      return true;
    },

    CLEAR_NETWORK_RULE_LOG(_message, _sender, sendResponse) {
      respondAsync(
        browser.storage.session
          .set({ [NETWORK_RULES_LOG_KEY]: [] })
          .then(() => ({ ok: true })),
        sendResponse
      );
      return true;
    },

    GET_CSP_DISABLED(message, _sender, sendResponse) {
      sendResponse({
        ok: true,
        disabled: isCspDisabledForTab(message.tabId),
      });
      return false;
    },

    SET_CSP_DISABLED(message, _sender, sendResponse) {
      setCspDisabledForTab(message.tabId, Boolean(message.disabled));
      sendResponse({ ok: true });
      return false;
    },

    TEST_NETWORK_RULE(message, _sender, sendResponse) {
      const ruleId = message.ruleId;
      const url = String(message.url || "").trim();
      if (!ruleId || !url) {
        sendResponse({ ok: false, error: "Rule id and URL are required." });
        return false;
      }
      respondAsync(
        startTestRuleSession(ruleId, url).then((result) => ({ ok: true, ...result })),
        sendResponse
      );
      return true;
    },
  };
}

globalThis.createBackgroundMessageHandlers = createBackgroundMessageHandlers;
