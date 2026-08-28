/**
 * Pure CSP compose helpers: which rules touch CSP, how to seed, how to punch.
 * No browser APIs — unit-tested from Node.
 */

export const CSP_HEADER_NAME = "Content-Security-Policy";

/**
 * @param {string} [name]
 */
export function isCspHeaderName(name) {
  return String(name || "").toLowerCase() === "content-security-policy";
}

/**
 * @param {string} [url]
 * @returns {string}
 */
export function originFromUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.origin;
  } catch {
    return "";
  }
}

/**
 * @param {object} [rule]
 */
export function isCspTouchingRule(rule) {
  if (!rule?.enabled || rule.action !== "modify") {
    return false;
  }
  const types = rule.resourceTypes || [];
  if (
    types.length &&
    !types.includes("main_frame") &&
    !types.includes("sub_frame")
  ) {
    return false;
  }
  const mod = rule.modify || {};
  if (mod.cspMode === "disable" || mod.cspSeed === "original" || mod.cspSeed === "empty") {
    return true;
  }
  if ((mod.setHeaders || []).some((header) => isCspHeaderName(header.name))) {
    return true;
  }
  if (
    (mod.headerReplacements || []).some(
      (entry) => entry.name && isCspHeaderName(entry.name)
    )
  ) {
    return true;
  }
  return false;
}

/**
 * @param {object} [rule]
 */
export function ruleSeedsOriginal(rule) {
  return rule?.modify?.cspSeed === "original";
}

/**
 * @param {object} [rule]
 */
export function ruleDisablesCsp(rule) {
  if (rule?.modify?.cspMode === "disable") {
    return true;
  }
  return (rule?.modify?.setHeaders || []).some(
    (header) => isCspHeaderName(header.name) && !String(header.value || "").trim()
  );
}

/**
 * Wildcard / empty patterns that would DNR-strip every document.
 * @param {object} [rule]
 */
export function cspRuleMatchesAllUrls(rule) {
  const page = String(rule?.pageUrlPattern || "").trim();
  const request = String(rule?.requestUrlPattern || "").trim();
  if (rule?.pageUrlPatternIsRegex || rule?.requestUrlPatternIsRegex) {
    return false;
  }
  const all =
    !page && !request
      ? true
      : isAllUrlsWildcard(page) && isAllUrlsWildcard(request || page);
  return all;
}

/**
 * @param {string} pattern
 */
export function isAllUrlsWildcard(pattern) {
  const value = String(pattern || "").trim();
  return (
    !value ||
    value === "*" ||
    value === "*://*/*" ||
    value === "http://*/*" ||
    value === "https://*/*" ||
    value === "<all_urls>"
  );
}

/**
 * Map a wildcard URL pattern to a DNR urlFilter, or null when unsafe/unknown.
 * Regex rules fail closed (null). All-URLs wildcards return "".
 * @param {string} pattern
 * @param {boolean} [isRegex]
 * @returns {string | null}
 */
export function wildcardToDnrUrlFilter(pattern, isRegex = false) {
  if (isRegex) {
    return null;
  }
  const value = String(pattern || "").trim();
  if (isAllUrlsWildcard(value)) {
    return "";
  }
  if (!value || /[()[\]{}?+|\\]/.test(value)) {
    return null;
  }
  if (value.startsWith("||") || value.startsWith("|")) {
    return value;
  }
  try {
    const withScheme = value.includes("://") ? value : `https://${value}`;
    const url = new URL(withScheme.replace(/\*/g, "wildcard-placeholder"));
    if (url.hostname.includes("wildcard-placeholder")) {
      const host = String(pattern)
        .replace(/^https?:\/\//i, "")
        .split("/")[0]
        .replace(/^\*\./, "");
      if (!host || host.includes("*")) {
        return null;
      }
      return `||${host}/`;
    }
    return `|${url.origin}/`;
  } catch {
    return null;
  }
}

/**
 * Apply CSP-touching rules in order to a seed policy string.
 * `applyModify` is the network engine's applyModifyReplacements.
 * @param {string} seedPolicy
 * @param {object[]} rules
 * @param {(ctx: object, rule: object) => object} applyModify
 * @returns {{ policy: string, disabled: boolean }}
 */
export function applyCspTouchingRules(seedPolicy, rules, applyModify) {
  let policy = seedPolicy == null ? "" : String(seedPolicy);
  for (const rule of rules) {
    if (ruleDisablesCsp(rule)) {
      return { policy: "", disabled: true };
    }
    const ctx = applyModify(
      {
        headers: { [CSP_HEADER_NAME]: policy },
        phase: "response",
      },
      rule
    );
    const next = ctx?.headers?.[CSP_HEADER_NAME];
    policy = next == null ? "" : String(next);
  }
  return { policy, disabled: false };
}

/**
 * @param {boolean} nonceToggle
 * @param {object[]} matchingCspRules
 */
export function shouldSeedOriginal(nonceToggle, matchingCspRules) {
  if (nonceToggle) {
    return true;
  }
  return matchingCspRules.some(ruleSeedsOriginal);
}

/**
 * Whether an armed CSP-touching rule can be represented as a DNR urlFilter.
 * Regex and undigestible wildcards fail closed (no strip).
 * @param {object} [rule]
 */
export function cspTouchingRuleIsDnrRepresentable(rule) {
  if (rule?.pageUrlPatternIsRegex || rule?.requestUrlPatternIsRegex) {
    return false;
  }
  const page = String(rule?.pageUrlPattern || "").trim();
  const request = String(rule?.requestUrlPattern || "").trim();
  const pageFilter = wildcardToDnrUrlFilter(page, false);
  const requestFilter = wildcardToDnrUrlFilter(request, false);
  if (page && pageFilter == null) {
    return false;
  }
  if (request && requestFilter == null) {
    return false;
  }
  const urlFilter = requestFilter || pageFilter || "";
  if (
    !urlFilter &&
    !isAllUrlsWildcard(page) &&
    !isAllUrlsWildcard(request) &&
    (page || request)
  ) {
    return false;
  }
  return true;
}

/**
 * Whether this document should go through DNR-strip + listener-add.
 * @param {{ nonceToggle: boolean, networkArmed: boolean, matchingCspRules: object[] }} input
 */
export function shouldRewriteCsp(input) {
  if (input.nonceToggle) {
    return true;
  }
  return Boolean(
    input.networkArmed &&
      (input.matchingCspRules || []).some(cspTouchingRuleIsDnrRepresentable)
  );
}

/**
 * 10-minute network-session alarm runs only while armed with ≥1 enabled rule.
 * @param {boolean} armed
 * @param {number} enabledRuleCount
 */
export function networkArmTimerActive(armed, enabledRuleCount) {
  return Boolean(armed && enabledRuleCount > 0);
}
