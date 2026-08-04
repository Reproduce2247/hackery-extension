/**
 * Classic content script (document_start). Cannot import ESM message-types;
 * string must stay in sync with MessageTypes.RUN_INJECT_CODES in lib/message-types.js.
 */
(function () {
  browser.runtime
    .sendMessage({ type: "RUN_INJECT_CODES", url: location.href })
    .catch(() => {});
})();
