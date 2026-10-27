import { AI_PROVIDERS } from "../shared/constants/providers.js";

/**
 * Detect xAI Grok models by id pattern (grok-*, Grok_*, etc).
 * @param {string} modelId
 * @returns {boolean}
 */
export function isXaiModel(modelId) {
  return typeof modelId === "string" && /^grok[-_]/i.test(modelId.trim());
}

// Pre-compute name-to-id map for O(1) provider lookup by display name
const NAME_TO_ID_MAP = new Map(
  Object.values(AI_PROVIDERS)
    .filter((entry) => entry && entry.name)
    .map((entry) => [entry.name.toLowerCase(), entry.id])
);

// Bounded memoization cache for high-throughput gateway routing
const NORMALIZE_CACHE = new Map();
const CACHE_LIMIT = 500;

/**
 * Normalize provider identifier or display name to canonical provider ID.
 * Optimized with O(1) lookup Map and bounded LRU memoization.
 * @param {string} provider
 * @returns {string}
 */
export function normalizeProviderId(provider) {
  if (typeof provider !== "string") return provider;

  const cached = NORMALIZE_CACHE.get(provider);
  if (cached !== undefined) return cached;

  const trimmed = provider.trim();
  let result = trimmed;

  if (AI_PROVIDERS[trimmed]) {
    result = trimmed;
  } else {
    const slug = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (AI_PROVIDERS[slug]) {
      result = slug;
    } else {
      const idByName = NAME_TO_ID_MAP.get(trimmed.toLowerCase());
      if (idByName) {
        result = idByName;
      }
    }
  }

  if (NORMALIZE_CACHE.size >= CACHE_LIMIT) {
    NORMALIZE_CACHE.clear();
  }
  NORMALIZE_CACHE.set(provider, result);

  return result;
}

export function normalizeProviderSpecificData(provider, body = {}, providerSpecificData = null) {
  const next = providerSpecificData && typeof providerSpecificData === "object"
    ? { ...providerSpecificData }
    : {};

  if (provider === "ollama-local") {
    const baseUrl = (
      next.baseUrl ||
      body.baseUrl ||
      body.baseURL ||
      body.ollamaHostUrl ||
      ""
    ).trim();

    if (baseUrl) next.baseUrl = baseUrl;
  }

  return Object.keys(next).length > 0 ? next : null;
}
