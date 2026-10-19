// open-sse/services/circuitBreaker.js
// Circuit breaker pattern: CLOSED → OPEN → HALF-OPEN → CLOSED
// Tracks consecutive failures per provider/executor; opens circuit when threshold exceeded
//
// OBSERVABILITY
// Every state change emits a structured log line and increments a counter.
// A breaker that opens and closes silently is a control that cannot be
// audited: the gauge published by /api/metrics is the state at scrape time,
// a snapshot of a moment, and it cannot say when the circuit opened, how
// long it stayed open, or whether it has been flapping. The transition is
// the event; the gauge is the state.

import { structuredInfo, structuredWarn } from "@/sse/utils/logger.js";
import { incrementCounter } from "@/sse/services/metrics.js";

const CircuitBreakerState = {
  CLOSED: "closed",
  OPEN: "open",
  HALF_OPEN: "half-open",
};

class CircuitBreaker {
  constructor(config = {}) {
    this.provider = config.provider || "default";
    // Use ?? so an explicit 0 is honoured (e.g. a zero cool-down in tests).
    // `||` would silently coerce 0 to the default and make the breaker
    // impossible to configure for immediate recovery.
    this.failureThreshold = Number.isFinite(config.failureThreshold) && config.failureThreshold > 0
      ? config.failureThreshold
      : 5;
    this.coolDownWindowMs = Number.isFinite(config.coolDownWindowMs) && config.coolDownWindowMs >= 0
      ? config.coolDownWindowMs
      : 300000; // 5 min
    this.resetWindowMs = Number.isFinite(config.resetWindowMs) && config.resetWindowMs >= 0
      ? config.resetWindowMs
      : 900000; // 15 min
    this.state = CircuitBreakerState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.lastStateChangeTime = Date.now();
    this.nextRetryTime = 0;
    // HALF_OPEN admits exactly one probe request. The slot is claimed by
    // canRequest() and released by recordSuccess()/recordFailure().
    this.probeInFlight = false;
    this.probeStartedAt = 0;
  }

  // Record a failure and check if circuit should open
  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitBreakerState.CLOSED && this.failureCount >= this.failureThreshold) {
      this.transitionTo(CircuitBreakerState.OPEN, "failure threshold reached");
    } else if (this.state === CircuitBreakerState.HALF_OPEN) {
      // In half-open state, any failure re-opens the circuit
      this.transitionTo(CircuitBreakerState.OPEN, "the half-open probe failed");
    }
  }

  // Record a successful call and reset if in half-open state
  recordSuccess() {
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.reset("the half-open probe succeeded");
    } else if (this.state === CircuitBreakerState.OPEN) {
      // A request that was already in flight when the circuit opened has come
      // back with a real response, so the provider is demonstrably healthy
      // again. Close the circuit rather than keeping it open until the
      // cool-down elapses.
      this.reset("an in-flight request succeeded");
    } else if (this.state === CircuitBreakerState.CLOSED) {
      // Reset failure count on success in closed state
      this.failureCount = 0;
    }
  }

  /**
   * Pure availability check. Changes no state, so it is safe to call from a
   * status read (a metrics scrape or a health probe must not half-open a
   * circuit that is supposed to be failing fast).
   */
  isAvailable(now = Date.now()) {
    if (this.state === CircuitBreakerState.CLOSED) return true;

    if (this.state === CircuitBreakerState.OPEN) {
      // The cool-down has elapsed, so a probe would be allowed.
      return now - this.lastStateChangeTime >= this.coolDownWindowMs;
    }

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      // Available only when no probe is currently in flight.
      return !this.probeInFlight;
    }

    return false;
  }

  /**
   * Check if circuit allows a request through.
   *
   * This is the request-path entry point and it may change state: it
   * promotes OPEN -> HALF_OPEN once the cool-down has elapsed and claims the
   * single probe slot that HALF_OPEN allows.
   */
  canRequest() {
    const now = Date.now();

    if (this.state === CircuitBreakerState.CLOSED) {
      return true;
    }

    if (this.state === CircuitBreakerState.OPEN) {
      // Check if cool-down window has elapsed
      if (now - this.lastStateChangeTime >= this.coolDownWindowMs) {
        this.transitionTo(CircuitBreakerState.HALF_OPEN, "the cool-down elapsed");
        this.probeInFlight = true;
        this.probeStartedAt = now;
        return true;
      }
      return false;
    }

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      // Allow one probe request through. If a probe was claimed but never
      // resolved (the request crashed or was dropped), release the slot once
      // the reset window has elapsed so the breaker cannot get stuck open.
      if (this.probeInFlight && now - this.probeStartedAt < this.resetWindowMs) {
        return false;
      }
      this.probeInFlight = true;
      this.probeStartedAt = now;
      return true;
    }

    return false;
  }

  /**
   * Release the half-open probe slot without recording an outcome.
   *
   * `canRequest()` claims the slot, so a caller that decides not to make an
   * upstream request at all (no credentials, every account locked) must
   * release it. Otherwise the circuit stays in HALF_OPEN with the slot held
   * and every later request is refused for the whole reset window — a
   * healthy provider blackholed by a purely local account problem.
   */
  releaseProbe() {
    if (this.state !== CircuitBreakerState.HALF_OPEN) return false;
    this.probeInFlight = false;
    this.probeStartedAt = 0;
    return true;
  }

  transitionTo(newState, reason = "") {
    const from = this.state;
    this.state = newState;
    this.lastStateChangeTime = Date.now();
    this.probeInFlight = false;
    this.probeStartedAt = 0;
    if (newState === CircuitBreakerState.OPEN) {
      this.nextRetryTime = this.lastStateChangeTime + this.coolDownWindowMs;
    } else if (newState === CircuitBreakerState.HALF_OPEN) {
      this.nextRetryTime = this.lastStateChangeTime + this.resetWindowMs;
    }
    this.announceTransition(from, newState, reason);
  }

  /**
   * Announce a state change: one structured log line and one counter.
   *
   * The log line carries the failure count and the threshold, so a reader can
   * tell "the provider was briefly flaky" from "the provider is down" without
   * correlating against another line. The counter is what makes the event
   * queryable: `sse_circuit_breaker_transitions_total` is a rate of state
   * changes, and a provider whose rate is not zero is flapping.
   */
  announceTransition(from, to, reason = "") {
    const fields = {
      provider: this.provider,
      from,
      to,
      failureCount: this.failureCount,
      failureThreshold: this.failureThreshold,
      coolDownMs: this.coolDownWindowMs,
    };
    if (reason) fields.reason = reason;

    if (to === CircuitBreakerState.OPEN) {
      structuredWarn("sse_circuit_breaker_open", fields);
    } else if (to === CircuitBreakerState.HALF_OPEN) {
      structuredInfo("sse_circuit_breaker_half_open", fields);
    } else {
      structuredInfo("sse_circuit_breaker_closed", fields);
    }

    incrementCounter("sse_circuit_breaker_transitions_total", { provider: this.provider, to });
  }

  reset(reason = "") {
    const from = this.state;
    this.state = CircuitBreakerState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.lastStateChangeTime = Date.now();
    this.nextRetryTime = 0;
    this.probeInFlight = false;
    this.probeStartedAt = 0;
    this.announceTransition(from, CircuitBreakerState.CLOSED, reason);
  }

  // Get current state for metrics. Side-effect free: reading the state must
  // not change it.
  getState() {
    return {
      provider: this.provider,
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      lastStateChangeTime: this.lastStateChangeTime,
      nextRetryTime: this.nextRetryTime,
      canRequest: this.isAvailable(),
    };
  }
}

// Global registry of circuit breakers per provider
const circuitBreakers = new Map();

// Get or create circuit breaker for a provider
function getCircuitBreaker(provider, config = {}) {
  const key = `${provider}`;
  if (!circuitBreakers.has(key)) {
    circuitBreakers.set(key, new CircuitBreaker({ provider, ...config }));
  }
  return circuitBreakers.get(key);
}

// Reset all circuit breakers (used in tests and on process restart).
//
// The registry is cleared rather than merely reset in place, so a breaker
// re-created afterwards picks up the config supplied by the caller. Keeping
// the old instances would silently ignore a new config and make behaviour
// depend on test ordering.
function resetAllCircuitBreakers() {
  circuitBreakers.clear();
}

// Get all circuit breaker states for metrics
function getAllCircuitBreakerStates() {
  const states = [];
  circuitBreakers.forEach((cb, provider) => {
    states.push(cb.getState());
  });
  return states;
}

export {
  CircuitBreaker,
  CircuitBreakerState,
  getCircuitBreaker,
  resetAllCircuitBreakers,
  getAllCircuitBreakerStates,
};
