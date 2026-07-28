import { getTargetTab } from "./tab-target.js";
import {
  readParamValuesFromRow,
  resolveNavigationUrl,
  saveParamValue,
  validateParamValues,
} from "./activate-link.js";

const { resolveNavScriptletUrl } = globalThis.SnLinksNav;

const {
  getParameterDefs,
  linkStorageKey,
  resolveNode,
  resolveParamValues,
} = globalThis.SnLinksLinkModel;

async function resolveCopyText(node, row) {
  const parameterDefs = getParameterDefs(node);
  const rawValues =
    row && parameterDefs.length > 0
      ? readParamValuesFromRow(row, parameterDefs)
      : {};
  const paramValues = resolveParamValues(parameterDefs, rawValues);
  const validationError = validateParamValues(parameterDefs, paramValues);
  if (validationError) {
    throw new Error(validationError);
  }

  const linkKey = linkStorageKey(node);
  for (const def of parameterDefs) {
    await saveParamValue(linkKey, def.name, paramValues[def.name]);
  }

  const resolved = resolveNode(node, paramValues);

  if (resolved.type === "scriptlet") {
    if (resolved.nav) {
      const hostPattern = resolved.hostPattern ?? null;
      const { tab, origin } = await getTargetTab(hostPattern);
      const url = resolveNavScriptletUrl(
        resolved.code,
        tab.url,
        origin,
        tab
      );
      if (!url) {
        throw new Error("Navigation script did not resolve to a URL.");
      }
      return url;
    }
    return resolved.code || "";
  }

  const hostPattern = resolved.hostPattern ?? null;
  const { tab, origin } = await getTargetTab(hostPattern);
  const url = await resolveNavigationUrl(
    resolved,
    tab,
    origin,
    paramValues
  );

  if (url === null) {
    if (resolved.type === "derived-url") {
      throw new Error("Could not derive URL from the current tab.");
    }
    throw new Error("No URL to copy.");
  }

  return url;
}

function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard copy failed.");
    }
  } finally {
    textarea.remove();
  }
}

function writeClipboardTextFromPromise(textPromise) {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    return navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": textPromise.then(
          (text) => new Blob([text], { type: "text/plain" })
        ),
      }),
    ]);
  }
  return textPromise.then((text) => writeClipboardText(text));
}

export function createCopyLink({ showMessage, hideMessage }) {
  return function copyLink(node, row = null) {
    hideMessage();

    writeClipboardTextFromPromise(resolveCopyText(node, row))
      .then(() => showMessage("Copied to clipboard."))
      .catch((error) => showMessage(error.message || String(error)));
  };
}
