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
  },
  // Per-provider overrides (merged with default)
  // Format: 'providerId': { failureThreshold, coolDownWindowMs, resetWindowMs }
  // Each field overrides the corresponding default; omitted fields keep the default
  providers: {
    // Example: 'openai': { failureThreshold: 3 }
  },
};

// Simple schema validation for circuit breaker config
// Validates: failureThreshold (positive integer), coolDownWindowMs (positive int ms), resetWindowMs (positive int ms)
export function validateCircuitBreakerConfig(config) {
  const errors = [];

  if (config.failureThreshold !== undefined) {
    if (!Number.isInteger(config.failureThreshold) || config.failureThreshold < 1) {
      errors.push("failureThreshold must be a positive integer");
    }
  }

  if (config.coolDownWindowMs !== undefined) {
    if (!Number.isInteger(config.coolDownWindowMs) || config.coolDownWindowMs < 1) {
      errors.push("coolDownWindowMs must be a positive integer (milliseconds)");
    }
  }

  if (config.resetWindowMs !== undefined) {
    if (!Number.isInteger(config.resetWindowMs) || config.resetWindowMs < 1) {
      errors.push("resetWindowMs must be a positive integer (milliseconds)");
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

// Schema validation for circuit breaker config
export const CIRCUIT_BREAKER_SCHEMA = {
  // Validates a single circuit breaker config entry
  // All fields are optional; missing fields fall back to defaults
  type: "object",
  properties: {
    failureThreshold: {
      type: "integer",
      minimum: 1,
    },
    coolDownWindowMs: {
      type: "integer",
      minimum: 1,
    },
    resetWindowMs: {
      type: "integer",
      minimum: 1,
    },
  },
  // Allow additional properties to false for strict validation
  additionalProperties: false,
};

