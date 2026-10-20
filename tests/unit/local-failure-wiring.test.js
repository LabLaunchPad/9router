/**
 * The "the provider was never asked anything" fact has to survive the trip
 * from the core to the breaker.
 *
 * Two things have to be true, and they live in different layers:
 *
 *   - the CORE has to say it. The core is the only place that knows whether
 *     an upstream call was made: it validates the request and builds the body
 *     before it fetches anything. A failure raised there is a local failure,
 *     and the result carries `upstreamContacted: false`.
 *   - the HANDLER has to pass it on. The handler is the only thing that
 *     talks to both the core and the breaker, so the fact has to cross it.
 *
 * A test of either half alone would pass while the chain was broken, which
 * is the shape this branch's reviews have kept finding: a control that
 * exists, is tested in isolation, and is not connected to the path it claims
 * to govern.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const authMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(async () => ({
    id: "conn-1",
    connectionId: "conn-1",
    connectionName: "Test",
    accessToken: "tok-1",
    apiKey: "key-1",
    provider: "openai",
    providerSpecificData: {},
  })),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false, cooldownMs: 0 })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));

const coreMocks = vi.hoisted(() => ({
  handleEmbeddingsCore: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => authMocks);
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "openai", model: "text-embedding-3-small" })),
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: vi.fn(async () => ({})),
  enforceKeyAccessResolved: vi.fn(async () => null),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_p, creds) => creds),
  updateProviderCredentials: vi.fn(async () => {}),
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("open-sse/handlers/embeddingsCore.js", () => coreMocks);

const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
// The real core, for the two cases that are about what the core produces.
// The handler drives the mocked one, so that the two halves of the chain
// are tested against the same contract.
const { handleEmbeddingsCore } = await vi.importActual("open-sse/handlers/embeddingsCore.js");

const request = () =>
  new Request("http://localhost/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
  });

beforeEach(() => {
  authMocks.markAccountUnavailable.mockClear();
  coreMocks.handleEmbeddingsCore.mockReset();
});

describe("the core says whether the provider was contacted", () => {
  it("marks a request it never sent as not contacted", async () => {
    const result = await handleEmbeddingsCore({
      body: {},
      modelInfo: { provider: "openai", model: "text-embedding-3-small" },
      credentials: { apiKey: "key-1" },
      log: { debug: () => {} },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(
      result.upstreamContacted,
      "a request that failed validation never reached the provider",
    ).toBe(false);
  });

  it("marks a request it could not build as not contacted", async () => {
    // A provider with no embeddings adapter: the core answers 400 without
    // fetching anything.
    const result = await handleEmbeddingsCore({
      body: { input: "hello" },
      modelInfo: { provider: "not-a-provider", model: "some-model" },
      credentials: { apiKey: "key-1" },
      log: { debug: () => {} },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.upstreamContacted).toBe(false);
  });
});

describe("the handler passes it on", () => {
  it("tells the breaker that the provider was never contacted", async () => {
    coreMocks.handleEmbeddingsCore.mockResolvedValueOnce({
      success: false,
      status: 400,
      error: "Missing required field: input",
      upstreamContacted: false,
    });

    await handleEmbeddings(request());

    expect(
      authMocks.markAccountUnavailable,
      "the local-failure fact has to reach the account-failure path",
    ).toHaveBeenCalledWith(
      "conn-1",
      400,
      "Missing required field: input",
      "openai",
      "text-embedding-3-small",
      false,
    );
  });

  it("assumes the provider was contacted when the core does not say", async () => {
    // An upstream failure: the provider WAS asked, and it answered with a
    // 502. The fact is absent, and the default has to be "contacted" — the
    // upstream case is the one that was already right.
    coreMocks.handleEmbeddingsCore.mockResolvedValueOnce({
      success: false,
      status: 502,
      error: "upstream failed",
    });

    await handleEmbeddings(request());

    expect(authMocks.markAccountUnavailable).toHaveBeenCalledWith(
      "conn-1",
      502,
      "upstream failed",
      "openai",
      "text-embedding-3-small",
      true,
    );
  });
});
