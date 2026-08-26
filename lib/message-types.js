/**
 * Runtime message type strings for the host (links / inject / CSP).
 * Senders and handlers must use these constants (not raw strings).
 */
export const MessageTypes = {
  RUN_SCRIPTLET: "RUN_SCRIPTLET",
  RUN_INJECT_CODES: "RUN_INJECT_CODES",
  REFRESH_INJECT: "REFRESH_INJECT",
  GET_EXTENSION_SETTINGS: "GET_EXTENSION_SETTINGS",
  SET_EXTENSION_SETTINGS: "SET_EXTENSION_SETTINGS",
  GET_CSP_DISABLED: "GET_CSP_DISABLED",
  SET_CSP_DISABLED: "SET_CSP_DISABLED",
  /** Background → sidebar: a tab's CSP state changed without being asked. */
  CSP_DISABLED_CHANGED: "CSP_DISABLED_CHANGED",
  /** Param prompt window → background: run this leaf with the entered values. */
  ACTIVATE_LINK_WITH_PARAMS: "ACTIVATE_LINK_WITH_PARAMS",
  GET_CONTEXT_TARGET: "GET_CONTEXT_TARGET",
  APPEND_ACTIVITY_LOG: "APPEND_ACTIVITY_LOG",
  GET_ACTIVITY_LOG: "GET_ACTIVITY_LOG",
  CLEAR_ACTIVITY_LOG: "CLEAR_ACTIVITY_LOG",
  ACTIVITY_LOG_CHANGED: "ACTIVITY_LOG_CHANGED",
};

/** All host message type values (for router unknown-type warnings). */
export const MessageTypeSet = new Set(Object.values(MessageTypes));
