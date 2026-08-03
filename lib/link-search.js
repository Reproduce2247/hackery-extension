/**
 * Shared fuzzy scoring for sidebar search and omnibox suggestions.
 */
(function () {
  function normalizeSearchQuery(raw) {
    return String(raw || "")
      .trim()
      .toLowerCase();
  }

  function isExactSearchMatch(label, query) {
    return Boolean(query) && String(label).toLowerCase() === query;
  }

  function searchMatchScore(label, query) {
    if (!query) {
      return 1;
    }

    const normalizedLabel = String(label).toLowerCase();
    if (normalizedLabel === query) {
      return 1000;
    }
    if (normalizedLabel.startsWith(query)) {
      return 500 + Math.max(0, 100 - query.length);
    }

    const index = normalizedLabel.indexOf(query);
    if (index === -1) {
      return 0;
    }

    return 200 - index;
  }

  function displayLabel(node) {
    return node.displayName || node.name || "";
  }

  function getSearchTags(node) {
    if (!Array.isArray(node.searchTags)) {
      return [];
    }
    return node.searchTags
      .filter((tag) => typeof tag === "string")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  function nodeSearchScore(node, query) {
    const q = normalizeSearchQuery(query);
    if (!q) {
      return 1;
    }

    let score = searchMatchScore(displayLabel(node), q);
    for (const tag of getSearchTags(node)) {
      score = Math.max(score, searchMatchScore(tag, q));
    }
    return score;
  }

  function nodeHasExactSearchMatch(node, query) {
    const q = normalizeSearchQuery(query);
    if (!q) {
      return false;
    }
    if (isExactSearchMatch(displayLabel(node), q)) {
      return true;
    }
    return getSearchTags(node).some((tag) => isExactSearchMatch(tag, q));
  }

  /**
   * Score a leaf against a query for omnibox / flat search.
   * @returns {{ node: object, score: number, label: string }}
   */
  function scoreLink(query, node) {
    const q = normalizeSearchQuery(query);
    const label = displayLabel(node);
    return {
      node,
      score: nodeSearchScore(node, q),
      label,
    };
  }

  /**
   * Flatten catalog sections and return scored matches (score > 0), best first.
   */
  function searchCatalog(catalog, query, limit = 10) {
    const LM = globalThis.SnLinksLinkModel;
    const q = normalizeSearchQuery(query);
    const results = [];
    for (const [sectionName, section] of Object.entries(catalog || {})) {
      const leaves = LM.flattenLinkNodes(
        section.children || [],
        section.match ?? null,
        sectionName
      );
      for (const node of leaves) {
        const scored = scoreLink(q, node);
        if (!q || scored.score > 0) {
          results.push(scored);
        }
      }
    }
    results.sort(
      (a, b) => b.score - a.score || a.label.localeCompare(b.label)
    );
    return results.slice(0, limit);
  }

  globalThis.SnLinksLinkSearch = {
    normalizeSearchQuery,
    isExactSearchMatch,
    searchMatchScore,
    displayLabel,
    getSearchTags,
    nodeSearchScore,
    nodeHasExactSearchMatch,
    scoreLink,
    searchCatalog,
  };
})();
