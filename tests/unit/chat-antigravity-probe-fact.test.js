/**
 * The antigravity quota path has to tell the breaker about the failure.
 *
 * The credential lookup claims the breaker's half-open probe, and the
 * antigravity quota path is the one path in the chat handler that does NOT
 * lock the account — it deliberately takes no account lock, because the
 * exhausted model is blocked in RAM until the upstream reset. The breaker is
 * a different question, and the path used to leave it unanswered: the probe
 * stayed claimed, and a claimed probe refuses the provider for the whole
 * reset window — fifteen minutes by default — with every refusal counted as
 * an error against the error budget.
 *
 * The path now goes through the same breaker entry point as every other
 * failure, and says `persistLock: false` — the account is not locked, the
 * breaker still hears. The provider ANSWERED on this path (a 409 or a 429
 * is an answer), so the fact is "the provider was asked".
 *
 * The mock below stands in for the real `markAccountUnavailable`: it tells
 * the breaker first, exactly as the real one does, so the assertions are
 * about what the handler asks the breaker to do.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const authMocks = vi.hoisted(() => {
  const mocks = {
    getProviderCredentials: vi.fn(),
    recordProviderFailure: vi.fn(() => true),
    markAccountUnavailable: vi.fn(),
    clearAccountError: vi.fn(async () => {}),
    handleChatCore: vi.fn(),
    handleAntigravityQuotaError: vi.fn(async () => 900000),
  };
  mocks.markAccountUnavailable.mockImplementation(
    async (connectionId, status, errorText, provider, model, options = {}) => {
      // The real entry point tells the breaker before it does anything else.
      mocks.recordProviderFailure(provider, status, {
        upstreamContacted: options.upstreamContacted ?? true,
      });
      return { shouldFallback: true, cooldownMs: 0 };
    },
  );
  return mocks;
});

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: authMocks.getProviderCredentials,
  recordProviderFailure: authMocks.recordProviderFailure,
  markAccountUnavailable: authMocks.markAccountUnavailable,
  clearAccountError: authMocks.clearAccountError,
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: authMocks.handleAntigravityQuotaError,
  clearAntigravityStrikes: vi.fn(),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "antigravity", model: "gemini-3-pro" }),
  getComboModels: () => null,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => ({}),
  enforceKeyAccess: async () => null,
  enforceKeyAccessResolved: async () => null,
  enforceKeyAccessProvider: async () => null,
  filterAdapterModels: (models) => models,
}));
vi.mock("open-sse/services/projectId.js", () => ({
  getProjectIdForConnection: async () => "project-1",
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: authMocks.handleChatCore }));
vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false }),
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getProviderNodes: async () => [],
  getCombos: async () => [],
  getProviderConnections: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => [] }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");

const request = () =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "antigravity/gemini-3-pro",
      stream: false,
      messages: [{ role: "user", content: "hi" }],
    }),
  });

const credentials = {
  id: "conn-1",
  connectionId: "conn-1",
  connectionName: "Antigravity",
  accessToken: "token-1",
  projectId: "project-1",
  provider: "antigravity",
  providerSpecificData: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.handleAntigravityQuotaError.mockResolvedValue(900000);
  // The first lookup claims the probe; the second one is the rotation to the
  // next account, and there is none.
  authMocks.getProviderCredentials
    .mockResolvedValueOnce(credentials)
    .mockResolvedValue(null);
  authMocks.handleChatCore.mockResolvedValue({
    success: false,
    status: 429,
    error: "quota exceeded",
    upstreamContacted: true,
    response: new Response(JSON.stringify({ error: { message: "quota exceeded" } }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    }),
  });
});

describe("the antigravity quota path: the breaker hears about the failure", () => {
  it("resolves the probe with the answer the provider gave", async () => {
    await handleChat(request());

    // The provider answered 429, so it was asked — and the half-open probe
    // the credential lookup claimed is resolved rather than left held.
    expect(authMocks.recordProviderFailure).toHaveBeenCalledWith("antigravity", 429, {
      upstreamContacted: true,
    });
  });

  it("still takes no account lock on this path", async () => {
    await handleChat(request());

    // The account is not locked here: the exhausted model is blocked in RAM
    // until the upstream reset, and this path must not persist a modelLock.
    // The breaker still hears — the two questions are independent.
    expect(authMocks.markAccountUnavailable).toHaveBeenCalledWith(
      "conn-1",
      429,
      "quota exceeded",
      "antigravity",
      "gemini-3-pro",
      expect.objectContaining({ persistLock: false, upstreamContacted: true }),
    );
  });
});
