// open-sse/services/circuitBreaker.js
// Circuit breaker pattern: CLOSED → OPEN → HALF-OPEN → CLOSED
// Tracks consecutive failures per provider/executor; opens circuit when threshold exceeded

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
  }

  // Record a failure and check if circuit should open
  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitBreakerState.CLOSED && this.failureCount >= this.failureThreshold) {
      this.transitionTo(CircuitBreakerState.OPEN);
    } else if (this.state === CircuitBreakerState.HALF_OPEN) {
      // In half-open state, any failure re-opens the circuit
      this.transitionTo(CircuitBreakerState.OPEN);
    }
  }

  // Record a successful call and reset if in half-open state
  recordSuccess() {
    if (this.state === CircuitBreakerState.HALF_OPEN) {
      this.reset();
    } else if (this.state === CircuitBreakerState.CLOSED) {
      // Reset failure count on success in closed state
      this.failureCount = 0;
    }
  }

  // Check if circuit allows a request through
  canRequest() {
    const now = Date.now();

    if (this.state === CircuitBreakerState.CLOSED) {
      return true;
    }

    if (this.state === CircuitBreakerState.OPEN) {
      // Check if cool-down window has elapsed
      if (now - this.lastStateChangeTime >= this.coolDownWindowMs) {
        this.transitionTo(CircuitBreakerState.HALF_OPEN);
        return true;
      }
      return false;
    }

    if (this.state === CircuitBreakerState.HALF_OPEN) {
      // Allow one probe request through
      return true;
    }

    return false;
  }

  transitionTo(newState) {
    this.state = newState;
    this.lastStateChangeTime = Date.now();
    if (newState === CircuitBreakerState.OPEN) {
      this.nextRetryTime = this.lastStateChangeTime + this.coolDownWindowMs;
    } else if (newState === CircuitBreakerState.HALF_OPEN) {
      this.nextRetryTime = this.lastStateChangeTime + this.resetWindowMs;
    }
  }

  reset() {
    this.state = CircuitBreakerState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = 0;
    this.lastStateChangeTime = Date.now();
    this.nextRetryTime = 0;
  }

  // Get current state for metrics
  getState() {
    return {
      provider: this.provider,
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      lastStateChangeTime: this.lastStateChangeTime,
      nextRetryTime: this.nextRetryTime,
      canRequest: this.canRequest(),
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

module.exports = {
  CircuitBreaker,
  CircuitBreakerState,
  getCircuitBreaker,
  resetAllCircuitBreakers,
  getAllCircuitBreakerStates,
};