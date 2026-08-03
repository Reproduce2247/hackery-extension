/** Thin ES-module facade over lib/activate-link.js (loaded via script tag). */
const A = () => globalThis.SnLinksActivate;

export async function loadParamValues() {
  return A().loadParamValues();
}

export async function saveParamValue(linkKey, paramName, value) {
  return A().saveParamValue(linkKey, paramName, value);
}

export function readParamValuesFromRow(row, parameterDefs) {
  return A().readParamValuesFromRow(row, parameterDefs);
}

export function validateParamValues(parameterDefs, values, options = {}) {
  return A().validateParamValues(parameterDefs, values, options);
}

/**
 * UI wrapper: shows messages; does not close the sidebar on navigate.
 */
export function createActivateLink({ showMessage, hideMessage }) {
  return async function activateLink(node, row = null) {
    hideMessage();
    try {
      const outcome = await A().activateLinkNode(node, { row });
      if (!outcome.ok) {
        showMessage(outcome.message || "Action failed.");
        return;
      }
      if (outcome.behaviorId === "run") {
        showMessage("Script ran — check the page console.");
      }
    } catch (error) {
      showMessage(error.message || String(error));
    }
  };
}
