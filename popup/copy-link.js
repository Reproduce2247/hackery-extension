import { getTargetTab } from "./tab-target.js";
import {
  readParamValuesFromRow,
  saveParamValue,
  validateParamValues,
} from "./activate-link.js";

const { resolveNavScriptletUrl, resolveUrlAction } = globalThis.SnLinksNav;
const { matchBehavior } = globalThis.SnLinksBehaviors;

const {
  getRuntimeValueDefs,
  getEditableValueDefs,
  linkStorageKey,
  resolveParamValues,
  seedNavParamValues,
} = globalThis.SnLinksLinkModel;

async function resolveCopyText(node, row) {
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

  const validationError = validateParamValues(
    runtimeDefs,
    {
      ...Object.fromEntries(
        runtimeDefs.map((def) => [def.name, paramValues[def.name] ?? ""])
      ),
      ...rawValues,
    },
    { isUrlAction }
  );
  if (validationError) {
    throw new Error(validationError);
  }

  const linkKey = linkStorageKey(node);
  for (const def of editableDefs) {
    await saveParamValue(linkKey, def.name, rawValues[def.name] ?? "");
  }

  if (behavior.id === "open-from-script") {
    const matchPattern = node.match ?? null;
    const { tab, origin } = await getTargetTab(matchPattern);
    const url = resolveNavScriptletUrl(
      node.code,
      tab.url,
      origin,
      tab,
      paramValues
    );
    if (!url) {
      throw new Error("Navigation script did not resolve to a URL.");
    }
    return url;
  }

  if (behavior.id === "run") {
    return node.code || "";
  }

  const matchPattern = node.match ?? null;
  const { tab, origin } = await getTargetTab(matchPattern);
  const url = await resolveUrlAction(node, tab, origin, paramValues);

  if (url === null) {
    throw new Error("Could not derive URL from the current tab.");
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
