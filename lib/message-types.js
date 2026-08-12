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
  FOCUS_SIDEBAR_LINK: "FOCUS_SIDEBAR_LINK",
  GET_CONTEXT_TARGET: "GET_CONTEXT_TARGET",
};

/** All host message type values (for router unknown-type warnings). */
export const MessageTypeSet = new Set(Object.values(MessageTypes));
