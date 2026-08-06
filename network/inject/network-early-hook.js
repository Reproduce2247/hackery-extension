/**
 * MAIN-world document_start gate. It captures requests made before the
 * configured network hook arrives, then hands them to that hook. If extension
 * setup fails, requests fall through to native APIs after a short delay.
 */
(function () {
  const root = globalThis;
  if (
    root.__ComplexLinkerNetworkHook ||
    root.__ComplexLinkerNetworkEarlyHook
  ) {
    return;
  }

  const natives = {
    fetch: root.fetch.bind(root),
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
    xhrSetRequestHeader: XMLHttpRequest.prototype.setRequestHeader,
  };
  let release;
  const configured = new Promise((resolve) => {
    release = resolve;
  });
  const readyOrTimeout = Promise.race([
    configured,
    new Promise((resolve) => root.setTimeout(resolve, 250)),
  ]);

  /**
   * Queue fetch until configuration arrives, then use the configured hook.
   * @param {RequestInfo | URL} input
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  function ComplexLinkerEarlyFetch(input, init) {
    return readyOrTimeout.then(() => {
      const nextFetch =
        root.fetch === ComplexLinkerEarlyFetch ? natives.fetch : root.fetch;
      return nextFetch(input, init);
    });
  }

  /**
   * Capture XHR metadata before the configured hook replaces this wrapper.
   * @param {string} method
   * @param {string | URL} url
   * @param {boolean} [async]
   * @param {string} [user]
   * @param {string} [password]
   * @returns {void}
   */
  function ComplexLinkerEarlyOpen(method, url, async, user, password) {
    this.__ComplexLinker = {
      method: String(method || "GET").toUpperCase(),
      url: String(url),
      async: async !== false,
      user,
      password,
      headers: {},
    };
    return natives.xhrOpen.call(this, method, url, async, user, password);
  }

  /**
   * Capture request headers for an XHR queued before hook configuration.
   * @param {string} name
   * @param {string} value
   * @returns {void}
   */
  function ComplexLinkerEarlySetRequestHeader(name, value) {
    if (this.__ComplexLinker) {
      this.__ComplexLinker.headers[name] = value;
    }
    return natives.xhrSetRequestHeader.call(this, name, value);
  }

  /**
   * Queue asynchronous XHR sends until configuration; synchronous XHR must
   * remain synchronous and therefore falls through immediately.
   * @param {Document | XMLHttpRequestBodyInit | null} [body]
   * @returns {void}
   */
  function ComplexLinkerEarlySend(body) {
    if (this.__ComplexLinker?.async === false) {
      return natives.xhrSend.call(this, body);
    }
    const xhr = this;
    readyOrTimeout.then(() => {
      const nextSend =
        XMLHttpRequest.prototype.send === ComplexLinkerEarlySend
          ? natives.xhrSend
          : XMLHttpRequest.prototype.send;
      nextSend.call(xhr, body);
    });
  }

  root.__ComplexLinkerNetworkEarlyHook = { natives, release };
  root.fetch = ComplexLinkerEarlyFetch;
  XMLHttpRequest.prototype.open = ComplexLinkerEarlyOpen;
  XMLHttpRequest.prototype.send = ComplexLinkerEarlySend;
  XMLHttpRequest.prototype.setRequestHeader =
    ComplexLinkerEarlySetRequestHeader;
})();
