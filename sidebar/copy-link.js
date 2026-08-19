import {
  readParamValuesFromRow,
  saveParamValue,
  validateParamValues,
} from "../lib/activate-link.js";
import { matchBehavior } from "../lib/link-behaviors.js";
import {
  getEditableValueDefs,
  getRuntimeValueDefs,
  linkStorageKey,
  resolveParamValues,
  seedNavParamValues,
} from "../lib/link-model.js";
import {
  coerceScriptletNavigationUrl,
  resolveUrlAction,
} from "../lib/navigation-shared.js";
import { executeScriptletWithBindings } from "../lib/scriptlet-inject.js";
import { getTargetTab } from "../lib/tab-target.js";

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
    // Nav scripts read page globals (g_form, g_list, GlideList2) and the page
    // DOM, so only the page can produce the URL. Same injection path as
    // activation, so copying succeeds exactly when Run does.
    const outcome = await executeScriptletWithBindings(tab.id, node.code, paramValues, {
      frames: node.frames,
    });
    const urls = [];
    for (const item of outcome.successes) {
      const url = coerceScriptletNavigationUrl(item.value, tab, origin);
      if (url) {
        urls.push(url);
      }
    }
    if (!urls.length) {
      throw new Error("Navigation script did not resolve to a URL.");
    }
    const copied = urls.join("\n");
    return { text: copied, someFailed: outcome.someFailed };
  }

  if (behavior.id === "run") {
    const code = node.code || "";
    // Injection binds params as function arguments (see executeScriptletWithBindings);
    // pasted code has no such scope, so emit them as declarations ahead of the snippet.
    const declarations = runtimeDefs
      .filter((def) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(def.name))
      .map(
        (def) =>
          `var ${def.name} = ${JSON.stringify(paramValues[def.name] ?? "")};`
      );
    return declarations.length ? `${declarations.join("\n")}\n${code}` : code;
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

    resolveCopyText(node, row)
      .then((result) => {
        const text = result && typeof result === "object" && "text" in result ? result.text : result;
        const someFailed = Boolean(result?.someFailed);
        return writeClipboardTextFromPromise(Promise.resolve(text)).then(() => {
          if (someFailed) {
            showMessage("failed in some frames");
            return;
          }
          showMessage("Copied to clipboard.");
        });
      })
      .catch((error) => showMessage(error.message || String(error)));
  };
}
