import { getTargetTab } from "./tab-target.js";

const { executeScriptletWithBindings } = globalThis.SnLinksScriptletInject;

const { matchBehavior } = globalThis.SnLinksBehaviors;

const {
  PARAM_VALUES_KEY,
  getRuntimeValueDefs,
  getEditableValueDefs,
  linkStorageKey,
  resolveParamValues,
  seedNavParamValues,
} = globalThis.SnLinksLinkModel;

export async function loadParamValues() {
  const stored = await browser.storage.local.get(PARAM_VALUES_KEY);
  return stored[PARAM_VALUES_KEY] || {};
}

export async function saveParamValue(linkKey, paramName, value) {
  const allValues = await loadParamValues();
  const linkValues = allValues[linkKey] || {};
  linkValues[paramName] = value;
  allValues[linkKey] = linkValues;
  await browser.storage.local.set({ [PARAM_VALUES_KEY]: allValues });
}

export function readParamValuesFromRow(row, parameterDefs) {
  const values = {};
  for (const def of parameterDefs) {
    const input = row.querySelector(`[data-param="${def.name}"]`);
    values[def.name] = input ? input.value.trim() : "";
  }
  return values;
}

/**
 * Validate values before run/navigate.
 * navParams with fromUrl/fromSelector may still be filled by derivation.
 */
export function validateParamValues(parameterDefs, values, options = {}) {
  const isUrlAction = Boolean(options.isUrlAction);
  const missing = parameterDefs
    .filter((def) => {
      if (def.optional || values[def.name]) {
        return false;
      }
      if (isUrlAction && (def.fromUrl || def.fromSelector)) {
        // Derivation may fill these; unresolved required values no-op at resolve time.
        return false;
      }
      if (isUrlAction && def.default !== "" && def.default !== undefined) {
        return false;
      }
      return true;
    })
    .map((def) => def.label || def.name);
  if (missing.length === 0) {
    return null;
  }
  if (missing.length === 1) {
    return `Enter a value for ${missing[0]}.`;
  }
  return `Enter values for ${missing.join(", ")}.`;
}

async function executeScriptlet(tabId, code, paramValues) {
  return executeScriptletWithBindings(tabId, code, paramValues);
}

export function createActivateLink({ showMessage, hideMessage }) {
  return async function activateLink(node, row = null) {
    hideMessage();

    try {
      const behavior = matchBehavior(node);
      if (!behavior) {
        throw new Error(`No behavior matched for "${node.name}".`);
      }

      const isUrlAction = behavior.id === "open-url";
      const runtimeDefs = getRuntimeValueDefs(node);
      const editableDefs = getEditableValueDefs(node);
      const rawValues =
        row && editableDefs.length > 0
          ? readParamValuesFromRow(row, editableDefs)
          : {};

      const paramValues = isUrlAction
        ? seedNavParamValues(runtimeDefs, rawValues)
        : resolveParamValues(runtimeDefs, rawValues);

      const validationError = validateParamValues(runtimeDefs, {
        ...Object.fromEntries(
          runtimeDefs.map((def) => [def.name, paramValues[def.name] ?? ""])
        ),
        ...rawValues,
      }, { isUrlAction });
      if (validationError) {
        showMessage(validationError);
        return;
      }

      const linkKey = linkStorageKey(node);
      for (const def of editableDefs) {
        await saveParamValue(linkKey, def.name, rawValues[def.name] ?? "");
      }

      const matchPattern = node.match ?? null;
      const { tab, origin } = await getTargetTab(matchPattern);
      // Switch to the matched host tab before injecting / navigating (same as pre-v2).
      if (matchPattern) {
        await browser.tabs.update(tab.id, { active: true });
      }

      const result = await behavior.run(node, {
        tab,
        origin,
        paramValues,
        executeScriptlet: executeScriptlet,
      });

      if (behavior.id === "open-url" && result?.url === null) {
        showMessage(
          "No URL derived from the current tab (pattern may not match, or already on the target page)."
        );
        return;
      }

      if (behavior.id === "run") {
        showMessage("Script ran — check the page console.");
        return;
      }

      if (behavior.id === "open-from-script" || behavior.id === "open-url") {
        window.close();
      }
    } catch (error) {
      showMessage(error.message || String(error));
    }
  };
}
