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

import { describe, expect, it, beforeEach } from "vitest";
import {
  getCircuitBreaker,
  resetAllCircuitBreakers,
} from "../../open-sse/services/circuitBreaker.js";
import {
  recordProviderFailure,
  recordProviderSuccess,
} from "../../src/sse/services/auth.js";

const PROVIDER = "9router-test-provider";

function breakerFor(provider = PROVIDER) {
  return getCircuitBreaker(provider, {
    failureThreshold: 3,
    coolDownWindowMs: 60000,
    resetWindowMs: 120000,
  });
}

beforeEach(() => {
  resetAllCircuitBreakers();
});

describe("circuit breaker: provider-level failures", () => {
  it("trips the breaker on an upstream 5xx", () => {
    const cb = breakerFor();

    for (let i = 0; i < 3; i++) {
      expect(recordProviderFailure(PROVIDER, 500)).toBe(true);
    }

    expect(cb.state).toBe("open");
    expect(cb.canRequest()).toBe(false);
  });

  it("trips the breaker on a transport error with no status", () => {
    const cb = breakerFor();

    for (let i = 0; i < 3; i++) {
      expect(recordProviderFailure(PROVIDER, undefined)).toBe(true);
    }

    expect(cb.state).toBe("open");
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
    const cb = breakerFor();

    for (let i = 0; i < 3; i++) recordProviderFailure(PROVIDER, 500);
    expect(cb.state).toBe("open");

    expect(recordProviderSuccess(PROVIDER)).toBe(true);
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(0);
  });

  it("resets the consecutive-failure count on a success", () => {
    const cb = breakerFor();

    recordProviderFailure(PROVIDER, 500);
    recordProviderFailure(PROVIDER, 500);
    recordProviderSuccess(PROVIDER);

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
});
