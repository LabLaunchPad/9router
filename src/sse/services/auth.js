import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { resolveProviderId, FREE_PROVIDERS } from "@/shared/constants/providers.js";
import { getAntigravityQuotaCache, getAntigravityModelQuota } from "./antigravityQuota.js";
import * as log from "../utils/logger.js";
import { CIRCUIT_BREAKER_CONFIG } from "open-sse/config/runtimeConfig.js";
import { getCircuitBreaker } from "open-sse/services/circuitBreaker.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// Helper: get per-provider circuit breaker config, merged with defaults
//
// Precedence: CIRCUIT_BREAKER_CONFIG.providers (the documented operator knob)
// > the provider registry entry > CIRCUIT_BREAKER_CONFIG.default.
//
// The runtime-config map used to be validated on import but never read, so an
// operator override there was silently ignored while still logging a startup
// warning — false confidence.
function getProviderCircuitBreakerConfig(providerId) {
  const defaults = CIRCUIT_BREAKER_CONFIG.default;
  const fromRuntimeConfig = CIRCUIT_BREAKER_CONFIG.providers?.[providerId] || {};

  // Look up the provider entry in the registry
  const providerEntry = REGISTRY.find(r => r.id === providerId || r.alias === providerId);
  const fromRegistry = providerEntry?.circuitBreaker || {};

  const pick = (key) => fromRuntimeConfig[key] ?? fromRegistry[key] ?? defaults[key];
  return {
    failureThreshold: pick("failureThreshold"),
    coolDownWindowMs: pick("coolDownWindowMs"),
    resetWindowMs: pick("resetWindowMs"),
    failureBurstMs: pick("failureBurstMs"),
  };
}

/**
 * Is this failure a signal about the PROVIDER, or about one credential?
 *
 * 401/403/402/429 mean "this account is bad, throttled, or out of quota" —
 * the provider itself is healthy, so they must not trip a provider-level
 * circuit. 5xx and transport errors (no status at all) mean the provider is
 * failing and every account will fail the same way.
 */
function isProviderLevelFailure(status) {
  const n = Number(status);
  // No status at all -> transport error (DNS, TCP, TLS, timeout).
  if (!Number.isFinite(n) || n <= 0) return true;
  return n >= 500;
}

/**
 * A burst of failures for the same provider is ONE outage, not N failures.
 *
 * The account-fallback loop tries the next credential whenever an account
 * fails, and `markAccountUnavailable()` is called once per account attempt.
 * A provider that answers every request with a 500 therefore produced N
 * provider-level failures for a single client request — which opened the
 * circuit after ONE request and let a single client take a whole provider
 * out of service for the cool-down window.
 *
 * `failureThreshold` is documented as *consecutive failures per provider*,
 * so the counting unit has to be the outage, not the account attempt.
 * Failures for the same provider within `failureBurstMs` are therefore
 * collapsed into one.
 *
 * The window is anchored at the START of the burst and is NOT refreshed by a
 * suppressed failure. Refreshing it on every failure would make the window
 * slide: during a continuous outage the failures keep arriving closer
 * together than the window, so every failure after the first would be
 * suppressed and the count would stay at 1 — the circuit would never open
 * for the whole duration of the outage, which is the exact situation the
 * breaker exists for.
 */
const lastProviderFailureAt = new Map();

/**
 * Record a provider-level failure on the circuit breaker.
 *
 * Called from the upstream error path, so a provider that is genuinely down
 * is skipped instead of being retried into the ground.
 *
 * @param {string|null} provider
 * @param {number|string|null} status - upstream HTTP status, if any
 * @returns {boolean} true when a failure was recorded on the breaker
 */
export function recordProviderFailure(provider, status) {
  if (!provider) return false;

  const providerId = resolveProviderId(provider);
  const cbConfig = getProviderCircuitBreakerConfig(providerId);
  const cb = getCircuitBreaker(providerId, cbConfig);

  if (!isProviderLevelFailure(status)) {
    // The provider ANSWERED (401/402/403/429) — it is alive. That is
    // exactly what isProviderLevelFailure means, and it resolves an
    // outstanding half-open probe: the probe asked "does this provider work
    // now?", the provider answered, so the probe is successful. Without
    // this the slot stays held for the whole reset window and a healthy
    // provider is blackholed for fifteen minutes.
    if (cb.state === "half-open") {
      lastProviderFailureAt.delete(providerId);
      cb.recordSuccess();
    }
    return false;
  }

  const now = Date.now();
  const last = lastProviderFailureAt.get(providerId) || 0;
  if (now - last < cbConfig.failureBurstMs) {
    // Same burst — already counted. The anchor is deliberately NOT moved:
    // see the note above.
    return false;
  }
  lastProviderFailureAt.set(providerId, now);

  cb.recordFailure();
  log.warn(
    "AUTH",
    `${provider} | provider failure (${status ?? "transport error"}) — breaker ${cb.state} (${cb.failureCount}/${cb.failureThreshold})`,
  );
  return true;
}

/**
 * Record a successful upstream response on the circuit breaker, so a provider
 * that has recovered closes the circuit promptly.
 *
 * This must be tied to an actual response, not to credential selection —
 * selecting a credential says nothing about whether the provider answered.
 */
export function recordProviderSuccess(provider) {
  if (!provider) return false;

  const providerId = resolveProviderId(provider);
  // A success ends the current burst: the next failure is a new outage and
  // has to count on its own.
  lastProviderFailureAt.delete(providerId);
  const cb = getCircuitBreaker(providerId, getProviderCircuitBreakerConfig(providerId));
  cb.recordSuccess();
  return true;
}

/**
 * Reset the provider-failure burst tracking.
 *
 * Only needed by tests: the burst window is a module-level map, so a test
 * that resets the circuit breakers would otherwise inherit the previous
 * test's burst state and see its first failure silently suppressed.
 */
export function resetProviderFailureTracking() {
  lastProviderFailureAt.clear();
}

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

const GITHUB_MONTHLY_USAGE_LIMIT = "you've reached your additional usage limit for your plan";

function githubMonthlyResetMs(status, errorText, provider) {
  if (resolveProviderId(provider) !== "github" || Number(status) !== 402) return null;
  if (!String(errorText || "").toLowerCase().includes(GITHUB_MONTHLY_USAGE_LIMIT)) return null;
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  const requestedModel = options?.requestedModel || model;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  // Hoisted so the catch below can release the half-open probe slot.
  let cb = null;

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Circuit breaker: fail fast if provider circuit is OPEN
    const cbConfig = getProviderCircuitBreakerConfig(providerId);
    cb = getCircuitBreaker(providerId, cbConfig);
    if (!cb.canRequest()) {
      log.warn("AUTH", `${provider} | circuit breaker OPEN — refusing request, state: ${cb.state}`);
      return null;
    }

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
          strictProxy: resolvedProxy.strictProxy === true,
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      // No credentials is an ACCOUNT problem, not a provider problem. The
      // provider may be perfectly healthy, and no upstream call is made
      // here, so there is nothing for the provider circuit to protect
      // against. Tripping it would let one misconfigured account take the
      // provider out of service for every other account on it.
      //
      // The half-open probe slot claimed by canRequest() above has to be
      // released: no upstream request is going to be made, so no
      // recordSuccess()/recordFailure() will ever resolve it.
      cb.releaseProbe();
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, and Antigravity quota-exhausted connections.
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      const enabled = c.providerSpecificData?.enabledModels;
      if (providerId === "codex" && Array.isArray(enabled) && enabled.length && requestedModel && !enabled.includes(requestedModel)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const connQuotas = antigravityQuotaCache.get(c.id);
        const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

    log.debug("AUTH", `${provider} | available: ${availableConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (availableConnections.length === 0) {
      // All accounts locked or rate-limited is again an ACCOUNT problem, not
      // a provider problem — the provider itself is healthy and no upstream
      // call is made. The provider circuit must not open for it: doing so
      // would let one account's exhausted quota blackhole the whole
      // provider. The per-account locks are handled by accountFallback.
      //
      // The half-open probe slot claimed by canRequest() above has to be
      // released: no upstream request is going to be made, so no
      // recordSuccess()/recordFailure() will ever resolve it.
      cb.releaseProbe();
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const connQuotas = antigravityQuotaCache.get(c.id);
          const quota = getAntigravityModelQuota(connQuotas, model) || connQuotas?.[model];
          const resetAt = quota?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        const earliestConn = lockedConns[0];
        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${earliestConn?.lastError?.slice(0, 50)}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError: earliestConn?.lastError || null,
          lastErrorCode: earliestConn?.errorCode || null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    const settings = await getSettings();
    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = availableConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...availableConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...availableConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = availableConnections[0];
    }

    // NOTE: the circuit breaker is deliberately NOT reset here. Selecting a
    // credential says nothing about whether the provider answered — a
    // provider that is down still hands out credentials happily. The breaker
    // is closed by a real upstream response (recordProviderSuccess) and
    // tripped by a real upstream failure (recordProviderFailure).

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        strictProxy: resolvedProxy.strictProxy === true,
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } catch (err) {
    // The half-open probe slot was claimed by canRequest() above, but this
    // function threw before an upstream request could be made. Nothing will
    // ever call recordSuccess()/recordFailure() for it, so release it here
    // rather than blocking the provider for the whole reset window.
    cb?.releaseProbe?.();
    throw err;
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  // A provider-level failure (5xx, transport error) trips the circuit
  // breaker. This is the upstream error path, so a provider that is genuinely
  // down is skipped instead of being retried into the ground. Per-account
  // problems (401/403/402/429) are ignored here — see isProviderLevelFailure.
  recordProviderFailure(provider, status);

  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;

  // GitHub premium-request exhaustion is account-wide until the next UTC month.
  const githubResetAtMs = githubMonthlyResetMs(status, errorText, provider);

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (githubResetAtMs) {
    shouldFallback = true;
    cooldownMs = githubResetAtMs - Date.now();
    newBackoffLevel = 0;
  } else if (resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel, resolveProviderId(provider)));
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = typeof errorText === "string" ? errorText.slice(0, 200) : "Provider error";
  const lockUpdate = buildModelLockUpdate(githubResetAtMs ? null : model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * - Closes the provider circuit breaker (the provider answered, so it is up)
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 * @param {string|null} provider - provider id; derived from the connection when omitted
 */
export async function clearAccountError(connectionId, currentConnection, model = null, provider = null) {
  // A successful upstream response is the only trustworthy "the provider is
  // healthy" signal. Recording it on credential selection instead (which is
  // what this used to do) reset the breaker before the request had even been
  // sent, so a provider that was down never tripped.
  const connForProvider = currentConnection?._connection || currentConnection;
  recordProviderSuccess(provider || connForProvider?.provider || null);

  if (!connectionId || connectionId === "noauth") return;
  const conn = connForProvider;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Extract API key from request headers
 */
export function extractApiKey(request) {
  // Check Authorization header first
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check Anthropic x-api-key header
  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) {
    return xApiKey;
  }

  return null;
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
