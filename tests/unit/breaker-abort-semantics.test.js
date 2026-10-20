/**
 * A request the CLIENT abandoned is not a signal about the provider.
 *
 * The breaker's rule is explicit — "a provider that *answers* — even with a
 * 401 or a 429 — also resolves the probe: the probe asked 'does this
 * provider work now?', the provider replied, so the probe succeeded" — and
 * an abandoned request is not an answer. The provider may never have been
 * reached at all.
 *
 * The client disconnect is reported as 499: `chatCore` maps the executor's
 * rethrown AbortError to `createErrorResult(499, "Request aborted")`, and
 * the handler passes that status straight to `markAccountUnavailable`, which
 * hands it to `recordProviderFailure`.
 *
 * What must not happen:
 *
 *   - the circuit must not be closed as if the provider had replied, and
 *   - the circuit must not be tripped by a client that walked away.
 *
 * What must happen: the probe is released, so the next request is the probe
 * again.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  getCircuitBreaker,
  resetAllCircuitBreakers,
} from "../../open-sse/services/circuitBreaker.js";
import {
  recordProviderFailure,
  resetProviderFailureTracking,
} from "../../src/sse/services/auth.js";

const PROVIDER = "9router-abort-provider";

beforeEach(() => {
  resetAllCircuitBreakers();
  resetProviderFailureTracking();
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

describe("the breaker: a request the client abandoned", () => {
  it("does not record the provider as healthy", () => {
    const cb = halfOpenBreaker();

    // The request claims the probe: the cool-down has elapsed, so the
    // circuit half-opens and this request is the one probe.
    expect(cb.canRequest()).toBe(true);
    expect(cb.state).toBe("half-open");

    // The client disconnected. The request was abandoned before the
    // provider answered.
    recordProviderFailure(PROVIDER, 499);

    expect(
      cb.state,
      "an abandoned request must not close the circuit as if the provider had answered",
    ).toBe("half-open");
    expect(
      cb.canRequest(),
      "the released probe must be available to the next request",
    ).toBe(true);
  });

  it("does not trip the circuit either", () => {
    const cb = getCircuitBreaker(PROVIDER, {
      failureThreshold: 1,
      coolDownWindowMs: 60000,
      resetWindowMs: 120000,
    });
    expect(cb.state).toBe("closed");

    recordProviderFailure(PROVIDER, 499);

    expect(
      cb.state,
      "an abandoned request is not a provider-level failure",
    ).toBe("closed");
  });

  it("still resolves the probe, so the provider is not blackholed", () => {
    const cb = halfOpenBreaker();
    expect(cb.canRequest()).toBe(true);

    recordProviderFailure(PROVIDER, 499);

    // The probe must not stay claimed: a claimed probe refuses every
    // later request for the whole reset window.
    expect(
      cb.canRequest(),
      "the probe must be released, not held",
    ).toBe(true);
  });
});
