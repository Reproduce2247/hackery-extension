(function () {
  browser.runtime
    .sendMessage({ type: "GET_INJECT_CODES", url: location.href })
    .then((response) => {
      const codes = response?.codes;
      if (!codes?.length) return;

      const payload = codes
        .map((code) => `(function(){${code}})();`)
        .join("\n");

      const script = document.createElement("script");
      script.textContent = payload;
      const root = document.documentElement || document.head || document;
      root.appendChild(script);
      script.remove();
    })
    .catch(() => {});
})();
