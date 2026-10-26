/**
 * Model search filtering utility with support for:
 * 1. Case-insensitive substring matching
 * 2. Negation / exclusion tokens (!keyword or -keyword)
 * 3. Combined queries (e.g. "claude !haiku")
 * 4. Regular expressions (/pattern/flags or /pattern/)
 */

/**
 * Parse a raw search query into a structured query object.
 * @param {string|null|undefined} rawQuery
 * @returns {{
 *   raw: string,
 *   isEmpty: boolean,
 *   isRegex: boolean,
 *   regex: RegExp|null,
 *   positiveTerms: string[],
 *   negativeTerms: string[]
 * }}
 */
export function parseSearchQuery(rawQuery) {
  if (!rawQuery || typeof rawQuery !== "string") {
    return {
      raw: "",
      isEmpty: true,
      isRegex: false,
      regex: null,
      positiveTerms: [],
      negativeTerms: [],
    };
  }

  const trimmed = rawQuery.trim();
  if (!trimmed) {
    return {
      raw: "",
      isEmpty: true,
      isRegex: false,
      regex: null,
      positiveTerms: [],
      negativeTerms: [],
    };
  }

  // Check for regex syntax: /pattern/flags or /pattern/
  if (trimmed.startsWith("/")) {
    const fullRegexMatch = trimmed.match(/^\/(.+)\/([a-z]*)$/i);
    if (fullRegexMatch) {
      try {
        const flags = fullRegexMatch[2] || "i";
        const regex = new RegExp(fullRegexMatch[1], flags);
        return {
          raw: trimmed,
          isEmpty: false,
          isRegex: true,
          regex,
          positiveTerms: [],
          negativeTerms: [],
        };
      } catch {
        // Invalid regex flags or syntax - fallback to literal
      }
    } else if (trimmed.length > 1) {
      // Allow live typing for leading slash, e.g. /claude.*
      try {
        const regex = new RegExp(trimmed.slice(1), "i");
        return {
          raw: trimmed,
          isEmpty: false,
          isRegex: true,
          regex,
          positiveTerms: [],
          negativeTerms: [],
        };
      } catch {
        // Syntax not yet valid while typing (e.g. unclosed parenthesis)
      }
    }
  }

  // Standard term parsing with negation support
  const tokens = trimmed.split(/\s+/);
  const positiveTerms = [];
  const negativeTerms = [];

  for (const token of tokens) {
    if (!token) continue;
    if ((token.startsWith("!") || token.startsWith("-")) && token.length > 1) {
      negativeTerms.push(token.slice(1).toLowerCase());
    } else {
      positiveTerms.push(token.toLowerCase());
    }
  }

  return {
    raw: trimmed,
    isEmpty: positiveTerms.length === 0 && negativeTerms.length === 0,
    isRegex: false,
    regex: null,
    positiveTerms,
    negativeTerms,
  };
}

/**
 * Check if a set of candidate strings matches the parsed query.
 * @param {string|string[]|object} target
 * @param {ReturnType<typeof parseSearchQuery>|string} queryOrParsed
 * @returns {boolean}
 */
export function matchesSearch(target, queryOrParsed) {
  const parsed = typeof queryOrParsed === "string" || !queryOrParsed
    ? parseSearchQuery(queryOrParsed)
    : queryOrParsed;

  if (parsed.isEmpty) {
    return true;
  }

  // Bolt Optimization: Extract candidates and convert to lowerCase directly to avoid
  // intermediate array allocation, .filter() calls, and subsequent .map() calls.
  let rawCandidates = null;
  const lowerCandidates = [];

  if (typeof target === "string") {
    if (parsed.isRegex) rawCandidates = [target];
    lowerCandidates.push(target.toLowerCase());
  } else if (Array.isArray(target)) {
    for (let i = 0; i < target.length; i++) {
      const item = target[i];
      if (typeof item === "string") {
        if (parsed.isRegex) (rawCandidates || (rawCandidates = [])).push(item);
        lowerCandidates.push(item.toLowerCase());
      }
    }
  } else if (target && typeof target === "object") {
    const { name, id, value, alias, provider } = target;
    if (typeof name === "string") {
      if (parsed.isRegex) (rawCandidates || (rawCandidates = [])).push(name);
      lowerCandidates.push(name.toLowerCase());
    }
    if (typeof id === "string") {
      if (parsed.isRegex) (rawCandidates || (rawCandidates = [])).push(id);
      lowerCandidates.push(id.toLowerCase());
    }
    if (typeof value === "string") {
      if (parsed.isRegex) (rawCandidates || (rawCandidates = [])).push(value);
      lowerCandidates.push(value.toLowerCase());
    }
    if (typeof alias === "string") {
      if (parsed.isRegex) (rawCandidates || (rawCandidates = [])).push(alias);
      lowerCandidates.push(alias.toLowerCase());
    }
    if (typeof provider === "string") {
      if (parsed.isRegex) (rawCandidates || (rawCandidates = [])).push(provider);
      lowerCandidates.push(provider.toLowerCase());
    }
  }

  if (lowerCandidates.length === 0) {
    return false;
  }

  // Handle Regex
  if (parsed.isRegex && parsed.regex) {
    const candidates = rawCandidates || lowerCandidates;
    const fullText = candidates.join(" ");
    const hasNegativeAssertion = /\(\?!|\(\?<!/.test(parsed.raw);
    if (hasNegativeAssertion) {
      return parsed.regex.test(fullText);
    }
    for (let i = 0; i < candidates.length; i++) {
      if (parsed.regex.test(candidates[i])) return true;
    }
    return parsed.regex.test(fullText);
  }

  // Handle Negations: reject if ANY candidate contains ANY negative term
  const negLen = parsed.negativeTerms.length;
  if (negLen > 0) {
    const candLen = lowerCandidates.length;
    for (let i = 0; i < negLen; i++) {
      const neg = parsed.negativeTerms[i];
      for (let j = 0; j < candLen; j++) {
        if (lowerCandidates[j].includes(neg)) {
          return false;
        }
      }
    }
  }

  // Handle Positive Terms: ALL positive terms must match at least one candidate
  const posLen = parsed.positiveTerms.length;
  if (posLen > 0) {
    const candLen = lowerCandidates.length;
    for (let i = 0; i < posLen; i++) {
      const pos = parsed.positiveTerms[i];
      let found = false;
      for (let j = 0; j < candLen; j++) {
        if (lowerCandidates[j].includes(pos)) {
          found = true;
          break;
        }
      }
      if (!found) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Filter an array of model or combo objects by a search query.
 * @param {Array} items
 * @param {string|ReturnType<typeof parseSearchQuery>} query
 * @returns {Array}
 */
export function filterModelsByQuery(items, query) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const parsed = typeof query === "string" || !query ? parseSearchQuery(query) : query;
  if (parsed.isEmpty) return items;
  return items.filter((item) => matchesSearch(item, parsed));
}
