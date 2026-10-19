/**
 * Circuit breaker — the integration that actually makes it work.
 *
 * The breaker's state machine has its own unit coverage, but a state machine
 * that is never driven by the request path is inert. These tests cover the
 * connection:
 *
 *   - an upstream 5xx / transport error trips the provider breaker,
 *   - a per-account problem (401) does NOT trip it, because the provider is
 *     healthy even when one credential is not,
 *   - a successful upstream response closes the circuit,
 *   - reading the breaker's state does not change it (a metrics scrape must
 *     not half-open a circuit that is supposed to be failing fast), and
 *   - HALF_OPEN admits exactly one probe request.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  getCircuitBreaker,
  resetAllCircuitBreakers,
} from "../../open-sse/services/circuitBreaker.js";
import {
  recordProviderFailure,
  recordProviderSuccess,
  resetProviderFailureTracking,
  getProviderCredentials,
} from "../../src/sse/services/auth.js";
import { CIRCUIT_BREAKER_CONFIG } from "../../open-sse/config/runtimeConfig.js";

const PROVIDER = "9router-test-provider";
const BURST_MS = CIRCUIT_BREAKER_CONFIG.default.failureBurstMs;

function breakerFor(provider = PROVIDER) {
  return getCircuitBreaker(provider, {
    failureThreshold: 3,
    coolDownWindowMs: 60000,
    resetWindowMs: 120000,
  });
}

beforeEach(() => {
  resetAllCircuitBreakers();
  resetProviderFailureTracking();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Record `n` failures that are far enough apart to count as separate
 * outage events.
 *
 * The separation is done with the CLOCK, not by clearing the tracking
 * state: clearing it would destroy the very thing under test. An earlier
 * version of this helper reset the burst window before every call, and that
 * is exactly why a sliding-window defect went unnoticed — the tests never
 * exercised two failures inside one window.
 */
function recordDistinctFailures(n, status = 500) {
  const recorded = [];
  for (let i = 0; i < n; i++) {
    vi.advanceTimersByTime(BURST_MS + 100);
    recorded.push(recordProviderFailure(PROVIDER, status));
  }
  return recorded;
}

describe("circuit breaker: provider-level failures", () => {
  it("trips the breaker on an upstream 5xx", () => {
    vi.useFakeTimers();
    const cb = breakerFor();

    expect(recordDistinctFailures(3)).toEqual([true, true, true]);

    expect(cb.state).toBe("open");
    expect(cb.canRequest()).toBe(false);
  });

  it("trips the breaker on a transport error with no status", () => {
    vi.useFakeTimers();
    const cb = breakerFor();

    expect(recordDistinctFailures(3, undefined)).toEqual([true, true, true]);

    expect(cb.state).toBe("open");
  });

  it("counts a burst of failures for the same provider as ONE outage", () => {
    const cb = breakerFor();

    // A single client request that walks N accounts against a provider that
    // is returning 500 records N failures. Without the burst collapse that
    // would open the circuit after one request and let a single client take
    // a whole provider out of service.
    expect(recordProviderFailure(PROVIDER, 500)).toBe(true);
    expect(recordProviderFailure(PROVIDER, 500)).toBe(false);
    expect(recordProviderFailure(PROVIDER, 500)).toBe(false);

    expect(cb.failureCount).toBe(1);
    expect(cb.state).toBe("closed");
  });

  it("still opens the circuit during a CONTINUOUS outage", () => {
    // The regression this test exists for: the burst window is anchored at
    // the START of the burst and is not moved by a suppressed failure.
    //
    // If the anchor slid, every failure in a continuous stream would fall
    // inside the window, only the first would be counted, and the circuit
    // would stay closed for the whole outage — the exact situation the
    // breaker exists to handle. The provider is hammered by every request
    // and every account is locked in the meantime.
    vi.useFakeTimers();
    const cb = breakerFor();

    // Failures arriving every 1900 ms — closer together than the 2000 ms
    // window, so consecutive failures are suppressed, but each one is more
    // than 2000 ms after the last COUNTED failure.
    const counted = [];
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(1900);
      counted.push(recordProviderFailure(PROVIDER, 500));
    }

    expect(counted.filter(Boolean).length).toBeGreaterThanOrEqual(3);
    expect(cb.state).toBe("open");
  });

  it("counts a failure after a success as a new outage", () => {
    const cb = breakerFor();

    expect(recordProviderFailure(PROVIDER, 500)).toBe(true);
    expect(recordProviderSuccess(PROVIDER)).toBe(true);
    // The success ended the burst, so the next failure counts on its own.
    expect(recordProviderFailure(PROVIDER, 500)).toBe(true);

    expect(cb.failureCount).toBe(1);
  });

  it("does NOT trip the breaker on a per-account problem", () => {
    const cb = breakerFor();

    // 401/403/402/429 are about one credential, not about the provider.
    for (let i = 0; i < 10; i++) {
      expect(recordProviderFailure(PROVIDER, 401)).toBe(false);
      expect(recordProviderFailure(PROVIDER, 429)).toBe(false);
      expect(recordProviderFailure(PROVIDER, 402)).toBe(false);
    }

    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(0);
  });

  it("does not record a failure when there is no provider", () => {
    expect(recordProviderFailure(null, 500)).toBe(false);
    expect(recordProviderFailure(undefined, 500)).toBe(false);
  });

  it("closes the circuit after a successful upstream response", () => {
    vi.useFakeTimers();
    const cb = breakerFor();

    recordDistinctFailures(3);
    expect(cb.state).toBe("open");

    expect(recordProviderSuccess(PROVIDER)).toBe(true);
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(0);
  });

  it("resets the consecutive-failure count on a success", () => {
    vi.useFakeTimers();
    const cb = breakerFor();

    recordDistinctFailures(2);
    expect(cb.failureCount).toBe(2);

    expect(recordProviderSuccess(PROVIDER)).toBe(true);

    expect(cb.failureCount).toBe(0);
    expect(cb.state).toBe("closed");
  });
});

describe("circuit breaker: reading the state must not change it", () => {
  it("does not half-open an open circuit when the state is read", async () => {
    const cb = getCircuitBreaker(PROVIDER, {
      failureThreshold: 2,
      coolDownWindowMs: 30,
      resetWindowMs: 60000,
    });

    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");

    // Let the cool-down elapse.
    await new Promise((r) => setTimeout(r, 60));

    // A health probe / metrics scrape reads the state. That must be inert:
    // if it promoted the circuit to half-open, the next request would be
    // admitted even though the provider is still down.
    const reported = cb.getState();
    expect(reported.state).toBe("open");
    expect(cb.state).toBe("open");
  });

  it("still allows a request once the cool-down has elapsed", async () => {
    const cb = getCircuitBreaker(PROVIDER, {
      failureThreshold: 2,
      coolDownWindowMs: 30,
      resetWindowMs: 60000,
    });

    cb.recordFailure();
    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 60));

    expect(cb.canRequest()).toBe(true);
    expect(cb.state).toBe("half-open");
  });
});

describe("circuit breaker: half-open admits one probe", () => {
  it("refuses a second request while the probe is in flight", () => {
    const cb = getCircuitBreaker(PROVIDER, {
      failureThreshold: 1,
      coolDownWindowMs: 60000,
      resetWindowMs: 120000,
    });

    cb.recordFailure();
    expect(cb.state).toBe("open");

    // Pretend the cool-down has elapsed: the first request takes the probe
    // slot and promotes the circuit to half-open.
    cb.lastStateChangeTime = Date.now() - 60000;
    expect(cb.canRequest()).toBe(true);
    expect(cb.state).toBe("half-open");

    // A second request while the probe is in flight is refused.
    expect(cb.canRequest()).toBe(false);
  });

  it("re-opens the circuit when the probe fails", () => {
    const cb = getCircuitBreaker(PROVIDER, {
      failureThreshold: 1,
      coolDownWindowMs: 60000,
      resetWindowMs: 120000,
    });

    cb.recordFailure();
    expect(cb.state).toBe("open");

    // Pretend the cool-down has elapsed so the next request takes the probe
    // slot and promotes the circuit to half-open.
    cb.lastStateChangeTime = Date.now() - 60000;
    expect(cb.canRequest()).toBe(true);
    expect(cb.state).toBe("half-open");

    cb.recordFailure();
    expect(cb.state).toBe("open");
    expect(cb.canRequest()).toBe(false);
  });

  it("releaseProbe() frees the slot for the next request", () => {
    const cb = getCircuitBreaker(PROVIDER, {
      failureThreshold: 1,
      coolDownWindowMs: 60000,
      resetWindowMs: 120000,
    });

    cb.recordFailure();
    cb.lastStateChangeTime = Date.now() - 60000;
    expect(cb.canRequest()).toBe(true);
    expect(cb.canRequest()).toBe(false);

    expect(cb.releaseProbe()).toBe(true);
    expect(cb.canRequest()).toBe(true);
  });

  it("resolves the probe when the provider answers with a 4xx", () => {
    // The provider is DOWN (5xx) so the circuit opens, then it recovers and
    // answers 429. The 429 is a per-account problem, not a provider problem,
    // so it does not trip the breaker — but the provider DID answer, which
    // is what the half-open probe was asking. Without resolving the probe
    // the slot stays held for the whole reset window and the provider is
    // blackholed for fifteen minutes even though it is working.
    const cb = getCircuitBreaker(PROVIDER, {
      failureThreshold: 1,
      coolDownWindowMs: 60000,
      resetWindowMs: 120000,
    });

    cb.recordFailure();
    expect(cb.state).toBe("open");

    // The cool-down elapses: the next request claims the probe.
    cb.lastStateChangeTime = Date.now() - 60000;
    expect(cb.canRequest()).toBe(true);
    expect(cb.state).toBe("half-open");

    // The provider answers 429 — alive, but throttling this account.
    expect(recordProviderFailure(PROVIDER, 429)).toBe(false);

    // The probe is resolved and the provider is usable again.
    expect(cb.state).toBe("closed");
    expect(cb.canRequest()).toBe(true);
  });
});

describe("circuit breaker: the probe slot is not leaked by a local account problem", () => {
  it("releases the probe when the provider has no credentials at all", async () => {
    const cb = getCircuitBreaker(PROVIDER, {
      failureThreshold: 1,
      coolDownWindowMs: 60000,
      resetWindowMs: 120000,
    });

    cb.recordFailure();
    cb.lastStateChangeTime = Date.now() - 60000;

    // No upstream request is made for an unknown provider with no
    // credentials, so no recordSuccess()/recordFailure() will ever resolve
    // the probe. The slot has to be released explicitly, otherwise the
    // provider is blackholed for the whole reset window.
    const creds = await getProviderCredentials(PROVIDER, null, null);
    expect(creds).toBeNull();

    expect(cb.state).toBe("half-open");
    expect(cb.canRequest()).toBe(true);
  });
});
