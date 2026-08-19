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

function framesHasDescendantBand(frames) {
  if (!frames) {
    return false;
  }
  const nesting = frames.nestingLevel;
  const hasMatch = Array.isArray(frames.match) && frames.match.length > 0;
  return nesting === -1 || (typeof nesting === "number" && nesting >= 1) || hasMatch;
}

function isEmptyFramesSpec(frames) {
  return Boolean(frames) && !frames.top && !framesHasDescendantBand(frames);
}

/**
 * Hops from the top document (frameId 0) via parentFrameId.
 * @param {number} frameId
 * @param {Map<number, { parentFrameId?: number }>} framesById
 */
export function frameDepth(frameId, framesById) {
  if (frameId === 0) {
    return 0;
  }
  let depth = 0;
  let id = frameId;
  const seen = new Set();
  while (id !== 0 && id != null && id !== -1) {
    if (seen.has(id)) {
      return Number.POSITIVE_INFINITY;
    }
    seen.add(id);
    const frame = framesById.get(id);
    if (!frame) {
      return Number.POSITIVE_INFINITY;
    }
    id = frame.parentFrameId;
    depth += 1;
    if (depth > 256) {
      return Number.POSITIVE_INFINITY;
    }
  }
  return depth;
}

/**
 * Whether a webNavigation frame record is in the leaf's frames target set.
 * Absent/empty `frames` means top document only.
 * @param {object | null | undefined} frames
 * @param {{ frameId: number, url?: string }} frame
 * @param {Array<{ frameId: number, parentFrameId?: number, url?: string }>} allFrames
 */
export function isFrameTargeted(frames, frame, allFrames) {
  if (!frames || isEmptyFramesSpec(frames)) {
    return frame.frameId === 0;
  }

  const framesById = new Map(allFrames.map((entry) => [entry.frameId, entry]));
  const depth = frameDepth(frame.frameId, framesById);
  const matchers = (frames.match || []).map((pattern) => new RegExp(pattern, "i"));
  const hasMatch = matchers.length > 0;
  const nesting = frames.nestingLevel;

  if (depth === 0) {
    return Boolean(frames.top);
  }

  let depthAllowed = false;
  if (nesting === -1) {
    depthAllowed = true;
  } else if (typeof nesting === "number" && nesting >= 1 && depth >= 1 && depth <= nesting) {
    depthAllowed = true;
  } else if ((nesting == null || nesting === 0) && hasMatch) {
    depthAllowed = true;
  }
  if (!depthAllowed) {
    return false;
  }
  if (!hasMatch) {
    return true;
  }
  return matchers.some((re) => re.test(frame.url || ""));
}

function metaFromFrameList(list) {
  const framesById = new Map(list.map((entry) => [entry.frameId, entry]));
  return list.map((entry) => ({
    frameId: entry.frameId,
    depth: frameDepth(entry.frameId, framesById),
    url: entry.url || "",
  }));
}

/**
 * Resolve executeScript target + per-frame metadata for a frames spec.
 * @param {number} tabId
 * @param {object | null | undefined} frames
 */
export async function resolveFrameTargets(tabId, frames) {
  const entireTree =
    Boolean(frames?.top) &&
    frames?.nestingLevel === -1 &&
    !(Array.isArray(frames.match) && frames.match.length);

  if (!frames || isEmptyFramesSpec(frames) || (frames.top && !framesHasDescendantBand(frames))) {
    let url = "";
    try {
      const list = await browser.webNavigation.getAllFrames({ tabId });
      url = list?.find((entry) => entry.frameId === 0)?.url || "";
    } catch {
      // restricted tab — table still logs frameId 0
    }
    return {
      allFrames: false,
      frameIds: [0],
      meta: [{ frameId: 0, depth: 0, url }],
    };
  }

  const list = await browser.webNavigation.getAllFrames({ tabId });
  const selected = (list || []).filter((entry) => isFrameTargeted(frames, entry, list));
  const meta = metaFromFrameList(selected);
  return {
    allFrames: entireTree,
    frameIds: meta.map((entry) => entry.frameId),
    meta,
  };
}

async function logFrameResultTable(tabId, rows) {
  const tableRows = rows.map((row) => ({
    frameId: row.frameId,
    depth: row.depth,
    url: row.url,
    ok: row.ok,
    error: row.error || "",
  }));
  try {
    await browser.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      injectImmediately: true,
      func: (entries) => {
        console.table(entries);
      },
      args: [tableRows],
    });
  } catch {
    // top frame may be restricted; results still drive throw/return
  }
}

function rowFromInjection(injection, metaById) {
  const frameId = injection?.frameId ?? 0;
  const meta = metaById.get(frameId) || {};
  if (injection?.error != null) {
    return {
      frameId,
      depth: meta.depth,
      url: meta.url || "",
      ok: false,
      error: formatScriptletError(injection.error),
      value: undefined,
    };
  }
  const payload = injection?.result;
  if (payload && payload.ok === false) {
    return {
      frameId,
      depth: meta.depth,
      url: meta.url || "",
      ok: false,
      error: formatScriptletError(payload.error),
      value: undefined,
    };
  }
  const value = payload && payload.ok === true ? payload.value : payload;
  return {
    frameId,
    depth: meta.depth,
    url: meta.url || "",
    ok: true,
    error: "",
    value,
  };
}

/**
 * Run scriptlet source in a tab with param keys as lexical bindings.
 * Always logs a per-frame console.table in the top document.
 * @param {number} tabId
 * @param {string} code
 * @param {Record<string, unknown>} paramValues
 * @param {{ frameId?: number, frames?: object }} [options]
 * @returns {Promise<{ successes: Array<{ frameId: number, value: unknown }>, someFailed: boolean }>}
 */
export async function executeScriptletWithBindings(tabId, code, paramValues = {}, options = {}) {
  if (!tabId) {
    throw new Error("No target tab for script injection.");
  }

  const names = Object.keys(paramValues);
  const values = names.map((name) => paramValues[name]);
  const target = { tabId };
  let meta = [];

  if (options.frameId != null) {
    target.frameIds = [options.frameId];
    try {
      const list = await browser.webNavigation.getAllFrames({ tabId });
      meta = metaFromFrameList((list || []).filter((entry) => entry.frameId === options.frameId));
    } catch {
      meta = [{ frameId: options.frameId, depth: options.frameId === 0 ? 0 : undefined, url: "" }];
    }
  } else if (options.frames) {
    const resolved = await resolveFrameTargets(tabId, options.frames);
    meta = resolved.meta;
    if (resolved.allFrames) {
      target.allFrames = true;
    } else if (resolved.frameIds.length) {
      target.frameIds = resolved.frameIds;
    }
  } else {
    const resolved = await resolveFrameTargets(tabId, { top: true });
    meta = resolved.meta;
    target.frameIds = [0];
  }

  const metaById = new Map(meta.map((entry) => [entry.frameId, entry]));

  if (!target.allFrames && (!target.frameIds || target.frameIds.length === 0)) {
    const emptyRows = [{ frameId: null, depth: undefined, url: "", ok: false, error: "No matching frames." }];
    await logFrameResultTable(tabId, emptyRows);
    throw new Error("failed in all frames");
  }

  // Catch inside the page so Chrome (no InjectionResult.error) and Firefox both surface throws.
  let injections = [];
  try {
    injections = await browser.scripting.executeScript({
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
  } catch (error) {
    const rows = [
      {
        frameId: target.frameIds?.[0] ?? 0,
        depth: meta[0]?.depth,
        url: meta[0]?.url || "",
        ok: false,
        error: formatScriptletError(error),
        value: undefined,
      },
    ];
    await logFrameResultTable(tabId, rows);
    throw new Error("failed in all frames");
  }

  if (target.allFrames && injections?.length) {
    try {
      const list = await browser.webNavigation.getAllFrames({ tabId });
      meta = metaFromFrameList(list || []);
      for (const entry of meta) {
        metaById.set(entry.frameId, entry);
      }
    } catch {
      // keep whatever meta we had
    }
  }

  const rows = (injections || []).map((injection) => rowFromInjection(injection, metaById));
  await logFrameResultTable(tabId, rows);

  const successes = rows
    .filter((row) => row.ok)
    .map((row) => ({ frameId: row.frameId, value: row.value }));
  const someFailed = rows.some((row) => !row.ok);

  if (!successes.length) {
    throw new Error("failed in all frames");
  }

  return { successes, someFailed };
}
