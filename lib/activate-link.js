/**
 * Activate a catalog leaf (run / open-url / open-from-script) without UI dependencies.
 * Used by sidebar, omnibox, and keyboard shortcuts.
 */
import { matchBehavior } from "./link-behaviors.js";
import { linkStableKey } from "./catalog-order.js";
import {
  getEditableValueDefs,
  getRuntimeValueDefs,
  linkStorageKey,
  resolveParamValues,
  seedNavParamValues,
} from "./link-model.js";
import { executeScriptletWithBindings } from "./scriptlet-inject.js";
import { StorageKeys } from "./storage-keys.js";
import { getTargetTab } from "./tab-target.js";

const { PARAM_VALUES_KEY, LAST_ACTIVATED_LINK_KEY } = StorageKeys;

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

async function executeScriptlet(tabId, code, paramValues, frames) {
  return executeScriptletWithBindings(tabId, code, paramValues, { frames });
}

/**
 * @param {object} node flattened leaf
 * @param {object} [options]
 * @param {HTMLElement|null} [options.row]
 * @param {Record<string,string>} [options.rawValues]
 * @param {number|null} [options.windowId] browser window to resolve the target tab in
 * @param {boolean} [options.allowMissingParams] if false, return needsParams
 * @returns {Promise<{ ok: boolean, needsParams?: boolean, message?: string, result?: object }>}
 */
export async function activateLinkNode(node, options = {}) {
  const behavior = matchBehavior(node);
  if (!behavior) {
    return {
      ok: false,
      message: `No behavior matched for "${node.name}".`,
    };
  }

  const isUrlAction = behavior.id === "open-url";
  const runtimeDefs = getRuntimeValueDefs(node);
  const editableDefs = getEditableValueDefs(node);
  const rawValues =
    options.rawValues ||
    (options.row && editableDefs.length > 0
      ? readParamValuesFromRow(options.row, editableDefs)
      : {});

  const stored = await loadParamValues();
  const linkKey = linkStorageKey(node);
  const storedValues = stored[linkKey] || {};
  const mergedRaw = { ...storedValues, ...rawValues };

  const paramValues = isUrlAction
    ? seedNavParamValues(runtimeDefs, mergedRaw)
    : resolveParamValues(runtimeDefs, mergedRaw);

  const validationError = validateParamValues(
    runtimeDefs,
    {
      ...Object.fromEntries(
        runtimeDefs.map((def) => [def.name, paramValues[def.name] ?? ""])
      ),
      ...mergedRaw,
    },
    { isUrlAction }
  );

  if (validationError) {
    if (options.allowMissingParams === false) {
      return { ok: false, needsParams: true, message: validationError };
    }
    return { ok: false, needsParams: true, message: validationError };
  }

  for (const def of editableDefs) {
    await saveParamValue(linkKey, def.name, mergedRaw[def.name] ?? "");
  }

  const matchPattern = node.match ?? null;
  const { tab, origin } = await getTargetTab(matchPattern, {
    windowId: options.windowId ?? null,
  });
  if (matchPattern) {
    await browser.tabs.update(tab.id, { active: true });
  }

  const result = await behavior.run(node, {
    tab,
    origin,
    paramValues,
    executeScriptlet,
  });

  try {
    await browser.storage.local.set({
      [LAST_ACTIVATED_LINK_KEY]:
        linkStableKey(node.sectionName, [], node) || linkKey,
    });
  } catch {
    // ignore
  }

  if (behavior.id === "open-url" && result?.url === null) {
    return {
      ok: false,
      message:
        "No URL derived from the current tab (pattern may not match, or already on the target page).",
    };
  }

  return { ok: true, result, behaviorId: behavior.id };
}
