/**
 * A request that never reached the provider is not a signal about it.
 *
 * The breaker has one rule for the half-open probe: it is resolved by a
 * provider that ANSWERS. `PRODUCTION_READINESS_CONTROLS.md` says it in the
 * operator-facing table:
 *
 *   | "no credentials configured" | **No** | A local configuration problem,
 *   |                             |       | and no upstream call is made. |
 *
 * and, for the probe itself:
 *
 *   The probe slot is claimed by `canRequest()` and released by the
 *   success/failure record — and explicitly by `releaseProbe()` on the paths
 *   where no upstream request is made at all (no credentials, every account
 *   locked), because otherwise the provider would be blackholed for the whole
 *   reset window by a purely local problem.
 *
 * A request that could not be BUILT is such a path. The core validates the
 * request before it makes any upstream call — a missing field, an adapter
 * that cannot build a body, a translation that fails — and answers `400`.
 * The provider was never asked anything:
 *
 *   - it is not a provider-level failure, so the circuit must not trip, and
 *   - it is not an answer, so the circuit must not close as if the provider
 *     had replied.
 *
 * What must happen instead is what happens on the other local paths: the
 * probe is RELEASED, so the next request is the probe again.
 *
 * Before the fix, a `400` reached the breaker's "the provider ANSWERED"
 * branch (every non-5xx did), so a client that sent a malformed request
 * could close the half-open circuit of a provider that was still down — the
 * provider was then declared healthy and traffic was sent back to it.
 *
 * The provider's own `400` is the case that must NOT change: there the
 * provider did answer, it is alive, and the probe was answered.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  getCircuitBreaker,
  resetAllCircuitBreakers,
} from "../../open-sse/services/circuitBreaker.js";
import {
  markAccountUnavailable,
  recordProviderFailure,
  resetProviderFailureTracking,
} from "../../src/sse/services/auth.js";
import { getMetricsSnapshot, resetMetrics } from "../../src/sse/services/metrics.js";

const PROVIDER = "9router-local-failure-provider";

beforeEach(() => {
  resetAllCircuitBreakers();
  resetProviderFailureTracking();
  resetMetrics();
});

/**
 * A breaker that has tripped and whose cool-down has elapsed, so the next
 * request is the half-open probe.
 */
function halfOpenBreaker(provider = PROVIDER) {
  const cb = getCircuitBreaker(provider, {
    failureThreshold: 1,
    coolDownWindowMs: 60000,
    resetWindowMs: 120000,
  });
  cb.recordFailure();
  expect(cb.state).toBe("open");
  cb.lastStateChangeTime = Date.now() - 60000;
  return cb;
}

describe("the breaker: a request that never reached the provider", () => {
  it("does not close the half-open circuit", () => {
    const cb = halfOpenBreaker();

    // The request claims the probe: the cool-down has elapsed, so the
    // circuit half-opens and this request is the one probe.
    expect(cb.canRequest()).toBe(true);
    expect(cb.state).toBe("half-open");

    // The request could not be built. No upstream call was made, so nothing
    // was learned about the provider.
    recordProviderFailure(PROVIDER, 400, { upstreamContacted: false });

    expect(
      cb.state,
      "a request that never reached the provider must not close the circuit as if it had answered",
    ).toBe("half-open");
  });

  it("releases the probe, so the provider is not blackholed", () => {
    const cb = halfOpenBreaker();
    expect(cb.canRequest()).toBe(true);

    recordProviderFailure(PROVIDER, 400, { upstreamContacted: false });

    // The availability check a health probe reads has to agree: a provider
    // whose probe was released is available. It is asked BEFORE the next
    // request, because asking for the next request claims the probe again.
    expect(
      cb.isAvailable(),
      "a released probe leaves the provider available",
    ).toBe(true);

    // A claimed probe refuses every later request for the whole reset
    // window, so a provider that is actually recovering would be blackholed
    // by a purely local problem.
    expect(
      cb.canRequest(),
      "the probe must be released, not held",
    ).toBe(true);
  });

  it("does not trip the circuit either", () => {
    const cb = getCircuitBreaker(PROVIDER, {
      failureThreshold: 1,
      coolDownWindowMs: 60000,
      resetWindowMs: 120000,
    });
    expect(cb.state).toBe("closed");

    recordProviderFailure(PROVIDER, 400, { upstreamContacted: false });

    expect(
      cb.state,
      "a request that never reached the provider is not a provider-level failure",
    ).toBe("closed");
  });

  it("reaches the breaker through the account-failure path", () => {
    const cb = halfOpenBreaker();
    expect(cb.canRequest()).toBe(true);

    // This is the shape the handlers use: the core's failure result goes to
    // `markAccountUnavailable`, which hands it to the breaker. A null
    // connection id stops it before the account lookup, so this exercises
    // the wiring and not the database.
    markAccountUnavailable(null, 400, "Missing required field: input", PROVIDER, null, {
      upstreamContacted: false,
    });

    expect(
      cb.state,
      "the local-failure signal must survive the trip through markAccountUnavailable",
    ).toBe("half-open");
  });

  it("is counted, so it can be seen", () => {
    // A failure mode that changes nothing observable is a failure mode
    // nobody can notice: the operator sees a healthy provider and a request
    // that failed for a reason that has nothing to do with the provider.
    recordProviderFailure(PROVIDER, 400, { upstreamContacted: false });

    const counters = getMetricsSnapshot().counters;
    const key = Object.keys(counters).find((k) =>
      k.startsWith("sse_provider_local_failures_total"),
    );
    expect(
      key,
      "a local failure has to be counted somewhere an operator can query",
    ).toBeDefined();
    expect(counters[key]).toBe(1);
  });
});

describe("the breaker: a provider that answered with 400", () => {
  it("still resolves the half-open probe", () => {
    const cb = halfOpenBreaker();
    expect(cb.canRequest()).toBe(true);

    // The provider DID answer. It is alive, even though it rejected the
    // request, so the probe was answered and the circuit closes. This is the
    // case the fix must not break: it is the same status as a local failure
    // and the opposite fact.
    recordProviderFailure(PROVIDER, 400);

    expect(
      cb.state,
      "a provider that answered must close the circuit, however it answered",
    ).toBe("closed");
  });
});
