// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
};

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envUrl(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}

// SearXNG endpoint used by the unauthenticated web-search provider.
// Configure this for a separate Docker service or remote SearXNG instance.
export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://localhost:8888/search");

// Inter-chunk stall timeout (once tokens are flowing). Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000);

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

export const TOKEN_SAVER_HEADER = "x-9router-token-saver";

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 }
};

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];

// Circuit breaker config
export const CIRCUIT_BREAKER_CONFIG = {
  // Default provider circuit breaker settings
  default: {
    failureThreshold: 5,
    coolDownWindowMs: 300000, // 5 minutes
    resetWindowMs: 900000,    // 15 minutes
    // Failures for the same provider within this window are ONE outage.
    //
    // The account-fallback loop retries the next credential whenever an
    // account fails, so a single client request against a provider that is
    // returning 500 produces one failure per account. Counting those
    // separately would open the circuit after a single request and let one
    // client take a whole provider out of service for the cool-down window.
    //
    // The window is anchored at the start of the burst; a suppressed failure
    // does not move it. Otherwise a continuous outage would keep the window
    // sliding and the count would never reach the threshold — the circuit
    // would never open at all, which is the situation the breaker exists for.
    failureBurstMs: 2000,
  },
  // Per-provider overrides (merged with default)
  // Format: 'providerId': { failureThreshold, coolDownWindowMs, resetWindowMs, failureBurstMs }
  // Each field overrides the corresponding default; omitted fields keep the default
  providers: {
    // Example: 'openai': { failureThreshold: 3 }
  },
};

// The schema is the CONTRACT: the validator below is derived from it, so
// the two cannot drift apart.
//
// It used to be a second, hand-written copy of the same rules that nothing
// read — and the copy was already wrong: it omitted `failureBurstMs` and
// forbade additional properties, while the validator accepted both. A
// schema that validates nothing is worse than no schema, because it
// advertises a guarantee that is not there.
export const CIRCUIT_BREAKER_SCHEMA = {
  // Validates a single circuit breaker config entry
  // All fields are optional; missing fields fall back to defaults
  type: "object",
  properties: {
    failureThreshold: {
      type: "integer",
      minimum: 1,
      message: "failureThreshold must be a positive integer",
    },
    coolDownWindowMs: {
      type: "integer",
      minimum: 1,
      message: "coolDownWindowMs must be a positive integer (milliseconds)",
    },
    resetWindowMs: {
      type: "integer",
      minimum: 1,
      message: "resetWindowMs must be a positive integer (milliseconds)",
    },
    failureBurstMs: {
      type: "integer",
      minimum: 0,
      message: "failureBurstMs must be a non-negative integer (milliseconds)",
    },
  },
  // Strict: an unknown setting is a typo, and a typo in a breaker config is
  // a breaker that does not behave the way its author read it.
  additionalProperties: false,
};

/**
 * Validate one circuit breaker config entry against CIRCUIT_BREAKER_SCHEMA.
 *
 * The rules come from the schema, so there is exactly one description of
 * what a valid config is. The thresholds it decides are the ones that take
 * a provider out of service, so a silently-accepted `failureThreshold: 0`
 * would trip a healthy provider on its first request.
 *
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateCircuitBreakerConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object") {
    return { valid: false, errors: ["config must be an object"] };
  }

  for (const [field, rule] of Object.entries(CIRCUIT_BREAKER_SCHEMA.properties)) {
    const value = config[field];
    // Every field is optional: a missing one falls back to the default.
    if (value === undefined) continue;
    if (rule.type === "integer" && !Number.isInteger(value)) {
      errors.push(rule.message);
      continue;
    }
    if (typeof rule.minimum === "number" && value < rule.minimum) {
      errors.push(rule.message);
    }
  }

  if (CIRCUIT_BREAKER_SCHEMA.additionalProperties === false) {
    for (const field of Object.keys(config)) {
      if (!(field in CIRCUIT_BREAKER_SCHEMA.properties)) {
        errors.push(`${field} is not a circuit breaker setting`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// Validate the default config on import
const defaultValidation = validateCircuitBreakerConfig(CIRCUIT_BREAKER_CONFIG.default);
if (!defaultValidation.valid) {
  console.error("CIRCUIT_BREAKER_CONFIG.default is invalid:", defaultValidation.errors);
}

// Validate per-provider configs
for (const [providerId, providerConfig] of Object.entries(CIRCUIT_BREAKER_CONFIG.providers)) {
  const pv = validateCircuitBreakerConfig(providerConfig);
  if (!pv.valid) {
    console.warn(`CIRCUIT_BREAKER_CONFIG.providers.${providerId} is invalid:`, pv.errors);
  }
}

// RTK strict mode: when true, RTK/headroom/caveman/ponytail errors propagate instead of fail-open
// Default: false (fail-open for backward compatibility)
// Env var override: RTK_STRICT=true|false
export const RTK_STRICT_MODE = process.env.RTK_STRICT === "true";

// Alias for consistency with ADR-006 naming
export const rtkStrict = RTK_STRICT_MODE;

