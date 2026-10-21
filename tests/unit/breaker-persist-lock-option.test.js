/**
 * The account lock and the breaker's opinion are TWO questions.
 *
 * `markAccountUnavailable` answers both on every path it is called on:
 *
 *   - the BREAKER is told about the failure, always, and
 *   - the ACCOUNT is locked, unless the caller says not to.
 *
 * `persistLock: false` is the caller saying "not to" — and it is the option
 * the Antigravity quota path depends on. That path blocks an exhausted
 * model in the RAM cache until the upstream reset, and a persisted
 * `modelLock_*` would outlive the reset it was derived from: the model
 * would stay locked for a window that has nothing to do with the quota
 * that locked it, on the one path that exists to avoid exactly that.
 *
 * The Antigravity path used to take no account lock because it did not
 * call this function at all. It now goes through the same entry point as
 * every other failure and says `persistLock: false` — so the branch that
 * honours the option is the only thing standing between that path and a
 * persisted lock.
 *
 * Nothing tested that branch. The behaviour was proven in
 * `github-monthly-usage-lock.test.js`, which drives this function with a
 * real connection id and asserts that the lock IS written — the opposite
 * of what this option asks for — and the only test that drove the real
 * function with a fact passed `connectionId: null`, which returns before
 * the lock is ever reached. The Antigravity test in
 * `chat-antigravity-probe-fact.test.js` mocks `markAccountUnavailable`
 * entirely, so it proves the handler ASKS for no lock; it cannot prove
 * that the lock is not written.
 *
 * These tests drive the REAL function, with a real connection id, and
 * check both answers: the breaker heard, and the account was not locked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/localDb", () => dbMocks);
vi.mock("@/lib/network/connectionProxy", () => ({
  pickProxyPoolId: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  structuredDebug: vi.fn(),
  structuredInfo: vi.fn(),
  structuredWarn: vi.fn(),
  structuredError: vi.fn(),
}));

const { markAccountUnavailable, resetProviderFailureTracking } = await import(
  "../../src/sse/services/auth.js"
);
const { getCircuitBreaker, resetAllCircuitBreakers } = await import(
  "../../open-sse/services/circuitBreaker.js"
);

const PROVIDER = "9router-persist-lock-provider";
const CONNECTION_ID = "conn-1";

beforeEach(() => {
  vi.clearAllMocks();
  resetAllCircuitBreakers();
  resetProviderFailureTracking();
  dbMocks.getProviderConnections.mockResolvedValue([
    { id: CONNECTION_ID, provider: PROVIDER, name: "conn-1", backoffLevel: 0 },
  ]);
  dbMocks.updateProviderConnection.mockResolvedValue(undefined);
});

describe("the account lock: asked for, or not", () => {
  it("does not write a lock when the path says not to", async () => {
    // The call the Antigravity quota path makes: the failure is real, the
    // account is NOT to be locked, and the breaker is to be told.
    await markAccountUnavailable(
      CONNECTION_ID,
      429,
      "quota exhausted for this model",
      PROVIDER,
      "model-x",
      { upstreamContacted: true, persistLock: false },
    );

    expect(
      dbMocks.updateProviderConnection,
      "a path that asks for no lock must not write one — the lock would outlive the reset it came from",
    ).not.toHaveBeenCalled();
  });

  it("still tells the breaker, so the two questions are answered separately", async () => {
    // The breaker is created here with a threshold of one, so the failure
    // below trips it. The instance is the one the function under test uses:
    // the breaker is keyed by provider, and the first configuration wins.
    const cb = getCircuitBreaker(PROVIDER, {
      failureThreshold: 1,
      coolDownWindowMs: 60000,
      resetWindowMs: 120000,
    });

    await markAccountUnavailable(
      CONNECTION_ID,
      500,
      "the provider answered with a server error",
      PROVIDER,
      "model-x",
      { upstreamContacted: true, persistLock: false },
    );

    expect(
      cb.state,
      "the breaker still has to hear about the failure: skipping the lock is not a reason to skip the breaker",
    ).toBe("open");
    expect(
      dbMocks.updateProviderConnection,
      "and the account is still not locked",
    ).not.toHaveBeenCalled();
  });

  it("still answers the caller the way the caller asked", async () => {
    // The path needs to know whether to rotate to the next account, and the
    // answer is about the ACCOUNT, not about the lock. Skipping the lock
    // must not turn the answer into "do not rotate".
    const result = await markAccountUnavailable(
      CONNECTION_ID,
      429,
      "quota exhausted for this model",
      PROVIDER,
      "model-x",
      { upstreamContacted: true, persistLock: false },
    );

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  it("keeps the precise cooldown of the upstream reset", async () => {
    // The Antigravity path blocks the model in RAM until the upstream reset,
    // so the cooldown it is given is that reset — not a truncated one. The
    // option that skips the lock must not truncate the window as well.
    const before = Date.now();
    const resetsAtMs = before + 3 * 60 * 60 * 1000;

    const result = await markAccountUnavailable(
      CONNECTION_ID,
      429,
      "quota exhausted for this model",
      "antigravity",
      "model-x",
      { upstreamContacted: true, resetsAtMs, persistLock: false },
    );

    expect(result.shouldFallback).toBe(true);
    // The cooldown is the time left until the reset, so it cannot be longer
    // than that and cannot be shorter by more than the call itself took.
    expect(result.cooldownMs).toBeLessThanOrEqual(resetsAtMs - before);
    expect(result.cooldownMs).toBeGreaterThan(resetsAtMs - Date.now() - 5000);
    expect(dbMocks.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("writes the lock when the path does not say otherwise", async () => {
    // The other half of the pair, and the reason the first half can be
    // trusted: the option is what makes the difference, not the function.
    // Without it, the lock is written exactly as it always was.
    await markAccountUnavailable(
      CONNECTION_ID,
      429,
      "quota exhausted for this model",
      PROVIDER,
      "model-x",
      { upstreamContacted: true },
    );

    expect(dbMocks.updateProviderConnection).toHaveBeenCalledWith(
      CONNECTION_ID,
      expect.objectContaining({ testStatus: "unavailable", errorCode: 429 }),
    );
    const written = dbMocks.updateProviderConnection.mock.calls[0][1];
    expect(
      Object.keys(written).some((k) => k.startsWith("modelLock_")),
      "the default is to lock the model",
    ).toBe(true);
  });
});
