/**
 * Format an InjectionResult.error or thrown page value for display.
 * @param {unknown} error
 */
export function formatScriptletError(error) {
  if (error == null) {
    return "Script threw an error.";
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error.message) {
    return String(error.message);
  }
  return String(error);
}

/**
 * Run scriptlet source in a tab with param keys as lexical bindings.
 * @param {number} tabId
 * @param {string} code
 * @param {Record<string, unknown>} paramValues
 * @param {{ frameId?: number }} [options]
 */
export async function executeScriptletWithBindings(tabId, code, paramValues = {}, options = {}) {
  if (!tabId) {
    throw new Error("No target tab for script injection.");
  }

  const names = Object.keys(paramValues);
  const values = names.map((name) => paramValues[name]);
  const target = { tabId };
  if (options.frameId != null) {
    target.frameIds = [options.frameId];
  }

  // Catch inside the page so Chrome (no InjectionResult.error) and Firefox both surface throws.
  const [injection] = await browser.scripting.executeScript({
    target,
    world: "MAIN",
    injectImmediately: true,
    func: (paramNames, paramValuesList, source) => {
      try {
        const value = !paramNames.length
          ? new Function(source)()
          : new Function(...paramNames, source)(...paramValuesList);
        return { ok: true, value };
      } catch (error) {
        return {
          ok: false,
          error:
            error && typeof error === "object" && "message" in error
              ? String(error.message)
              : String(error),
        };
      }
    },
    args: [names, values, code],
  });

  if (injection?.error != null) {
    throw new Error(`Script error: ${formatScriptletError(injection.error)}`);
  }

  const payload = injection?.result;
  if (payload && payload.ok === false) {
    throw new Error(`Script error: ${formatScriptletError(payload.error)}`);
  }
  if (payload && payload.ok === true) {
    return payload.value;
  }
  return payload;
}
