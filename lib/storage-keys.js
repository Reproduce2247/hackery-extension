const SnLinksStorageKeys = {
  PARAM_VALUES_KEY: "linkParamValues",
  INJECT_ON_LOAD_KEY: "injectOnLoad",
  CUSTOM_SCRIPTS_KEY: "customScripts",
  LINKS_OVERLAY_KEY: "linksJsonOverlay",
  INJECT_ON_LOAD_ENABLED_KEY: "injectOnLoadEnabled",
  LAST_ORIGINS_KEY: "lastOrigins",
  SECTION_TAB_KEY: "activeSectionTab",
  ADD_SCRIPT_EXPANDED_KEY: "addScriptExpanded",
  POPUP_SIZE_KEY: "popupSize",
  NETWORK_RULES_KEY: "networkRules",
  NETWORK_RULES_LOG_KEY: "networkRulesLog",
  NETWORK_SHARED_STATE_KEY: "networkSharedState",
  NETWORK_TAB_STATE_KEY: "networkTabState",
  NETWORK_HOOKS_ENABLED_KEY: "networkHooksEnabled",
  LINK_BUILDER_PREFILL_KEY: "linkBuilderPrefill",
  LINK_BUILDER_SECTION_KEY: "linkBuilderSection",
};

globalThis.SnLinksStorageKeys = SnLinksStorageKeys;

// Background scripts share one scope — use var so keys are visible across files.
var PARAM_VALUES_KEY = SnLinksStorageKeys.PARAM_VALUES_KEY;
var INJECT_ON_LOAD_KEY = SnLinksStorageKeys.INJECT_ON_LOAD_KEY;
var CUSTOM_SCRIPTS_KEY = SnLinksStorageKeys.CUSTOM_SCRIPTS_KEY;
var LINKS_OVERLAY_KEY = SnLinksStorageKeys.LINKS_OVERLAY_KEY;
var INJECT_ON_LOAD_ENABLED_KEY = SnLinksStorageKeys.INJECT_ON_LOAD_ENABLED_KEY;
var LAST_ORIGINS_KEY = SnLinksStorageKeys.LAST_ORIGINS_KEY;
var SECTION_TAB_KEY = SnLinksStorageKeys.SECTION_TAB_KEY;
var ADD_SCRIPT_EXPANDED_KEY = SnLinksStorageKeys.ADD_SCRIPT_EXPANDED_KEY;
var POPUP_SIZE_KEY = SnLinksStorageKeys.POPUP_SIZE_KEY;
var NETWORK_RULES_KEY = SnLinksStorageKeys.NETWORK_RULES_KEY;
var NETWORK_RULES_LOG_KEY = SnLinksStorageKeys.NETWORK_RULES_LOG_KEY;
var NETWORK_SHARED_STATE_KEY = SnLinksStorageKeys.NETWORK_SHARED_STATE_KEY;
var NETWORK_TAB_STATE_KEY = SnLinksStorageKeys.NETWORK_TAB_STATE_KEY;
var NETWORK_HOOKS_ENABLED_KEY = SnLinksStorageKeys.NETWORK_HOOKS_ENABLED_KEY;
