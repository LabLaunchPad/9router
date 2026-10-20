/**
 * The video path has to tell a client that walked away from a provider that
 * stopped answering.
 *
 * `handleVideoProxyCore` combines the request's own signal with a fetch
 * timeout, so the two failures arrive as the same `AbortError`/`TimeoutError`
 * pair — and they mean opposite things:
 *
 *  - the CLIENT cancelled. The provider may never have answered. The chat
 *    path reports this as 499, and the breaker releases the half-open probe
 *    for it: nothing was learned about the provider.
 *  - the UPSTREAM did not answer within VIDEO_FETCH_TIMEOUT_MS. That is a
 *    provider that is hanging, and every account would hang the same way, so
 *    the provider-level circuit has to see it — as the 502 every other core
 *    reports an upstream failure as.
 *
 * Folding them together (both were 408) left the breaker blind in both
 * directions: a client cancellation closed the half-open circuit as though
 * the provider had replied, and a provider timeout never tripped the circuit
 * at all — and 408 is not a 5xx, so the error budget did not see it either.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const authMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false, cooldownMs: 0 })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));
const tokenMocks = vi.hoisted(() => ({
  checkAndRefreshToken: vi.fn(async (_p, creds) => creds),
  updateProviderCredentials: vi.fn(async () => {}),
}));

vi.mock("@/sse/services/auth.js", () => authMocks);
vi.mock("@/sse/services/tokenRefresh.js", () => tokenMocks);
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
  getProviderConnectionById: vi.fn(async () => ({ id: "conn-5", provider: "xai" })),
  getComboByName: vi.fn(async () => null),
  getModelAliases: vi.fn(async () => ({})),
  getProviderNodes: vi.fn(async () => []),
}));
vi.mock("@/sse/utils/logger.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

const { handleVideoCreate } = await import("@/sse/handlers/videoGeneration.js");

const originalFetch = global.fetch;

const makeRequest = (body) =>
  new Request("http://localhost/v1/videos/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const account = () => ({
  connectionId: "conn-1",
  accessToken: "tok-1",
  refreshToken: "ref-1",
  authType: "oauth",
});

/** The error a fetch timeout raises. */
const timeoutError = () => {
  const err = new Error("The operation was aborted due to timeout");
  err.name = "TimeoutError";
  return err;
};

/** The error a client cancellation raises. */
const clientAbortError = () => {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
};

beforeEach(() => {
  global.fetch = vi.fn();
  authMocks.getProviderCredentials.mockReset();
  authMocks.markAccountUnavailable.mockClear();
  authMocks.clearAccountError.mockClear();
  tokenMocks.checkAndRefreshToken.mockClear();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("the video path tells a client cancellation from a provider timeout", () => {
  it("a provider timeout is a provider-level failure", async () => {
    authMocks.getProviderCredentials.mockResolvedValue(account());
    global.fetch.mockRejectedValueOnce(timeoutError());

    await handleVideoCreate(makeRequest({ model: "xai/grok-imagine-video", prompt: "a cat" }), "generations");

    // A 5xx is what the error budget reads, and what trips the provider
    // circuit. A timeout is the provider hanging, not the client.
    expect(authMocks.markAccountUnavailable).toHaveBeenCalledWith(
      "conn-1",
      502,
      expect.any(String),
      "xai",
      expect.anything(),
    );
  });

  it("a client cancellation is not a signal about the provider", async () => {
    authMocks.getProviderCredentials.mockResolvedValue(account());
    global.fetch.mockRejectedValueOnce(clientAbortError());

    await handleVideoCreate(makeRequest({ model: "xai/grok-imagine-video", prompt: "a cat" }), "generations");

    // 499 is the status chatCore uses for the same event, and the breaker
    // releases the half-open probe for it rather than closing the circuit
    // as though the provider had replied. The other half of that property -
    // what the breaker does with a 499 - is covered by
    // tests/unit/breaker-abort-semantics.test.js, which needs the real auth
    // module. Together the two files cover the chain.
    expect(authMocks.markAccountUnavailable).toHaveBeenCalledWith(
      "conn-1",
      499,
      expect.any(String),
      "xai",
      expect.anything(),
    );
  });
});