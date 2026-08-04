/**
 * Single writer for browser.action badge text/color.
 * Features contribute marks; the host merges them so writers do not race.
 */
export const BADGE_COLOR = "#81b5a1";

/** @type {Map<number, { networkMatched?: boolean }>} */
const tabFlags = new Map();

/**
 * @param {number} tabId
 * @param {{ networkMatched?: boolean }} patch
 */
export function patchTabFlags(tabId, patch) {
  if (tabId == null || tabId < 0) {
    return;
  }
  const prev = tabFlags.get(tabId) || {};
  tabFlags.set(tabId, { ...prev, ...patch });
}

/**
 * @param {number} tabId
 */
export function clearTabFlags(tabId) {
  tabFlags.delete(tabId);
}

export function getTabFlags(tabId) {
  return tabFlags.get(tabId) || {};
}

/**
 * @param {number} tabId
 * @param {string} text
 */
export async function setBadgeText(tabId, text) {
  if (tabId == null || tabId < 0) {
    return;
  }
  try {
    await browser.action.setBadgeBackgroundColor({ color: BADGE_COLOR, tabId });
    await browser.action.setBadgeText({ text: text || "", tabId });
  } catch {
    // badge unsupported or tab gone
  }
}

/**
 * Merge contributor marks into one badge string.
 * Convention: network "●", inject "+", both "●+".
 * @param {{ network?: string, inject?: string }} marks
 */
export function mergeMarks(marks) {
  const network = marks.network || "";
  const inject = marks.inject || "";
  if (network && inject) {
    return `${network}${inject}`;
  }
  return network || inject || "";
}

/**
 * @param {number} tabId
 * @param {{ network?: string, inject?: string }} marks
 */
export async function refresh(tabId, marks) {
  await setBadgeText(tabId, mergeMarks(marks));
}
