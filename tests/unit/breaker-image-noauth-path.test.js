/**
 * The no-auth image-generation path consults the breaker.
 *
 * `sdwebui` and `comfyui` are local servers: they take no credential, and
 * the image handler has a branch for them that calls the core directly.
 * That branch never went through the credential lookup, so it never
 * consulted the breaker and never reported a failure to it — a failing
 * `sdwebui` tripped nothing, and its provider was never taken out of
 * service.
 *
 * The path now goes through the lookup as its gate. The lookup is where the
 * breaker is consulted, and `noCredentialRequired` is what keeps it from
 * going looking for a connection that was never going to be there.
 *
 * The tests drive the handler, not the lookup: the lookup's own behaviour is
 * in `auth-no-credential-lookup.test.js`.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const authMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false, cooldownMs: 0 })),
  clearAccountError: vi.fn(async () => {}),
  recordProviderFailure: vi.fn(() => false),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));

const coreMocks = vi.hoisted(() => ({ handleImageGenerationCore: vi.fn() }));

vi.mock("@/sse/services/auth.js", () => authMocks);
vi.mock("open-sse/handlers/imageGenerationCore.js", () => coreMocks);
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "sdwebui", model: "sdxl-base-1.0" })),
  getComboModels: vi.fn(() => null),
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: vi.fn(async () => ({})),
  enforceKeyAccess: vi.fn(async () => null),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(),
  checkAndRefreshToken: vi.fn(async (_provider, credentials) => credentials),
}));
vi.mock("open-sse/services/combo.js", () => ({ handleComboChat: vi.fn() }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));

const { handleImageGeneration } = await import("../../src/sse/handlers/imageGeneration.js");

const request = () =>
  new Request("http://localhost/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "sdwebui/sdxl-base-1.0", prompt: "a cat" }),
  });

// What the lookup hands back for a provider that needs no credential.
const GATE = {
  id: "noauth",
  connectionName: "Public",
  provider: "sdwebui",
  providerSpecificData: {},
};

beforeEach(() => {
  authMocks.getProviderCredentials.mockReset();
  authMocks.getProviderCredentials.mockResolvedValue(GATE);
  authMocks.clearAccountError.mockClear();
  authMocks.recordProviderFailure.mockClear();
  coreMocks.handleImageGenerationCore.mockReset();
  coreMocks.handleImageGenerationCore.mockResolvedValue({
    success: true,
    response: new Response("ok"),
  });
});

describe("the no-auth image path consults the breaker", () => {
  it("asks the credential lookup, with the flag that says the provider needs no credential", async () => {
    await handleImageGeneration(request());

    expect(
      authMocks.getProviderCredentials,
      "the no-auth image path must consult the breaker before the upstream call",
    ).toHaveBeenCalledWith("sdwebui", null, "sdxl-base-1.0", { noCredentialRequired: true });
  });

  it("a refused circuit stops the request before the upstream call", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce(null);

    const response = await handleImageGeneration(request());

    expect(
      coreMocks.handleImageGenerationCore,
      "a refused circuit must stop the request before the upstream call",
    ).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
  });

  it("a provider-level failure is recorded on the breaker", async () => {
    coreMocks.handleImageGenerationCore.mockResolvedValueOnce({
      success: false,
      status: 502,
      error: "upstream failed",
      upstreamContacted: true,
    });

    await handleImageGeneration(request());

    expect(
      authMocks.recordProviderFailure,
      "a failed no-auth image request must trip the provider's circuit",
    ).toHaveBeenCalledWith("sdwebui", 502, { upstreamContacted: true });
  });

  it("a failure that never reached the provider says so", async () => {
    coreMocks.handleImageGenerationCore.mockResolvedValueOnce({
      success: false,
      status: 400,
      error: "Invalid sdwebui image request",
      upstreamContacted: false,
    });

    await handleImageGeneration(request());

    expect(
      authMocks.recordProviderFailure,
      "a request that never reached the provider must not be reported as one that did",
    ).toHaveBeenCalledWith("sdwebui", 400, { upstreamContacted: false });
  });

  it("a success resolves the half-open probe", async () => {
    coreMocks.handleImageGenerationCore.mockResolvedValueOnce({
      success: true,
      response: new Response("ok"),
    });

    await handleImageGeneration(request());

    expect(
      authMocks.clearAccountError,
      "a successful no-auth image request must resolve the breaker's probe",
    ).toHaveBeenCalled();
  });
});
