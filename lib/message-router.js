function createMessageRouter(handlers) {
  return function onRuntimeMessage(message, sender, sendResponse) {
    const handler = handlers[message?.type];
    if (!handler) {
      return false;
    }
    return handler(message, sender, sendResponse);
  };
}

function respondAsync(promise, sendResponse) {
  promise
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((error) =>
      sendResponse({ ok: false, error: error.message || String(error) })
    );
  return true;
}

globalThis.createMessageRouter = createMessageRouter;
globalThis.respondAsync = respondAsync;
