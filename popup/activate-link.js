import { getTargetTab } from "./tab-target.js";

const {
  toNavigatorPath,
  toNavigatorUrl,
  resolvePathOnTab,
  resolvePathUrl,
  resolveDerivedLink,
  evaluateNavScript,
  resolveAbsoluteUrl,
  resolveNav,
  performNavigation,
} = globalThis.SnLinksNav;

const {
  PARAM_VALUES_KEY,
  extractNavigationPath,
  getParameterDefs,
  linkStorageKey,
  resolveNode,
  resolveParamValues,
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

export function validateParamValues(parameterDefs, values) {
  const missing = parameterDefs
    .filter((def) => !def.optional && !values[def.name])
    .map((def) => def.label || def.name);
  if (missing.length === 0) {
    return null;
  }
  if (missing.length === 1) {
    return `Enter a value for ${missing[0]}.`;
  }
  return `Enter values for ${missing.join(", ")}.`;
}

async function runScriptlet(tabId, code) {
  const response = await browser.runtime.sendMessage({
    type: "RUN_SCRIPTLET",
    tabId,
    code,
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Script injection failed.");
  }
}

function resolveNavigationUrl(resolved, tab, origin, hostPattern, paramValues) {
  if (resolved.type === "derived-url") {
    return resolveDerivedLink(resolved, tab, origin, hostPattern, paramValues);
  }
  if (resolved.type === "navigate") {
    return resolvePathUrl(resolved.path, tab, origin, hostPattern);
  }
  if (resolved.type === "scriptlet" && resolved.nav) {
    const result = evaluateNavScript(resolved.code, tab.url);
    return resolveAbsoluteUrl(result, tab, origin, hostPattern);
  }
  return null;
}

export function createActivateLink({ showMessage, hideMessage }) {
  return async function activateLink(node, row = null) {
    hideMessage();

    try {
      const parameterDefs = getParameterDefs(node);
      const rawValues =
        row && parameterDefs.length > 0
          ? readParamValuesFromRow(row, parameterDefs)
          : {};
      const paramValues = resolveParamValues(parameterDefs, rawValues);
      const validationError = validateParamValues(parameterDefs, paramValues);
      if (validationError) {
        showMessage(validationError);
        return;
      }

      const linkKey = linkStorageKey(node);
      for (const def of parameterDefs) {
        await saveParamValue(linkKey, def.name, paramValues[def.name]);
      }

      const resolved = resolveNode(node, paramValues);

      if (resolved.type === "scriptlet" && !resolved.nav) {
        const navPath = extractNavigationPath(resolved.code);
        if (navPath) {
          const hostPattern = resolved.hostPattern ?? null;
          const { tab, origin } = await getTargetTab(hostPattern);
          const url = hostPattern
            ? toNavigatorUrl(origin, navPath)
            : resolvePathOnTab(tab, navPath);
          await performNavigation("same-tab", url, tab, hostPattern);
          window.close();
          return;
        }

        const hostPattern = resolved.hostPattern ?? null;
        const { tab } = await getTargetTab(hostPattern);
        if (hostPattern) {
          await browser.tabs.update(tab.id, { active: true });
        }
        await runScriptlet(tab.id, resolved.code);
        window.close();
        return;
      }

      const hostPattern = resolved.hostPattern ?? null;
      const { tab, origin } = await getTargetTab(hostPattern);
      const url = resolveNavigationUrl(
        resolved,
        tab,
        origin,
        hostPattern,
        paramValues
      );

      if (url === null) {
        if (resolved.type === "derived-url") {
          return;
        }
        window.close();
        return;
      }

      const nav = resolveNav(resolved);
      if (!nav) {
        throw new Error(`Navigation mode is required for ${resolved.type} links.`);
      }

      await performNavigation(nav, url, tab, hostPattern);
      window.close();
    } catch (error) {
      showMessage(error.message || String(error));
    }
  };
}
