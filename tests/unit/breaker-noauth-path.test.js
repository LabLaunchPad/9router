/**
 * The no-auth request paths consult the circuit breaker like every other
 * path.
 *
 * `getProviderCredentials` is the ONLY place in production code that calls
 * `canRequest()` — the breaker's one and only admission check. So it is
 * also the only way a request can be refused by an open circuit, and the
 * only way a provider's failure can be recorded.
 *
 * A request path that does not go through it is a path the breaker cannot
 * see: its provider is never taken out of service, and its failures never
 * trip anything.
 *
 * The no-auth TTS providers are real: `edge-tts`, `google-tts`, `coqui`,
 * `tortoise` and `local-device` are all `noAuth: true` with
 * `serviceKinds: ["tts"]`.
 */

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(async () => ({
    id: "noauth",
    connectionId: "noauth",
    connectionName: "Public",
    accessToken: "public",
    provider: "edge-tts",
    providerSpecificData: {},
  })),
  clearAccountError: vi.fn(async () => {}),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  recordProviderFailure: vi.fn(() => true),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, comboStrategy: "fallback" }),
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
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  recordProviderFailure: mocks.recordProviderFailure,
  extractApiKey: () => null,
  isValidApiKey: async () => true,
}));
vi.mock("open-sse/handlers/ttsCore.js", () => ({
  handleTtsCore: vi.fn(async () => ({
    success: false,
    status: 502,
    error: "upstream failed",
  })),
}));

const { handleTts } = await import("../../src/sse/handlers/tts.js");
const { handleStt } = await import("../../src/sse/handlers/stt.js");

const ttsRequest = () =>
  new Request("http://localhost/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "edge-tts/en-US-AriaNeural", input: "hello" }),
  });

const sttRequest = () => {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array([1, 2, 3])], "a.wav", { type: "audio/wav" }));
  fd.set("model", "edge-tts/en-US-AriaNeural");
  return new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: fd });
};

describe("the no-auth request paths consult the breaker", () => {
  it("the TTS path asks for credentials, which is where the breaker is consulted", async () => {
    mocks.getProviderCredentials.mockClear();

    await handleTts(ttsRequest());

    expect(
      mocks.getProviderCredentials,
      "the no-auth TTS path must consult the breaker before the upstream call",
    ).toHaveBeenCalled();
    // The lookup has to be told that the provider needs no credential. A
    // no-auth provider never has a connection, so without this the lookup
    // reports "no connection configured" — a null the path cannot tell
    // apart from "the circuit is open", and it refused every request to a
    // local speech server that was never in trouble.
    expect(
      mocks.getProviderCredentials.mock.calls[0][3],
      "the lookup must be told the provider needs no credential",
    ).toEqual({ noCredentialRequired: true });
  });

  it("the STT path asks for credentials, which is where the breaker is consulted", async () => {
    mocks.getProviderCredentials.mockClear();

    await handleStt(sttRequest());

    expect(
      mocks.getProviderCredentials,
      "the no-auth STT path must consult the breaker before the upstream call",
    ).toHaveBeenCalled();
    expect(
      mocks.getProviderCredentials.mock.calls[0][3],
      "the lookup must be told the provider needs no credential",
    ).toEqual({ noCredentialRequired: true });
  });

  it("a refused circuit stops the request before the upstream call", async () => {
    // `getProviderCredentials` returns null when the breaker refuses.
    mocks.getProviderCredentials.mockResolvedValueOnce(null);
    const { handleTtsCore } = await import("open-sse/handlers/ttsCore.js");
    handleTtsCore.mockClear();

    await handleTts(ttsRequest());

    expect(
      handleTtsCore,
      "a refused circuit must stop the request before the upstream call",
    ).not.toHaveBeenCalled();
  });

  it("a provider-level failure is recorded on the breaker", async () => {
    // The core fails with a 5xx, which is a signal about the provider.
    mocks.recordProviderFailure.mockClear();

    await handleTts(ttsRequest());

    expect(
      mocks.recordProviderFailure,
      "a failed no-auth request must trip the provider's circuit",
    ).toHaveBeenCalledWith("edge-tts", 502, { upstreamContacted: true });
  });

  it("a success resolves the half-open probe", async () => {
    // The core succeeds. The probe the credential lookup claimed has to be
    // resolved, or the provider is blackholed for the whole reset window.
    const { handleTtsCore } = await import("open-sse/handlers/ttsCore.js");
    handleTtsCore.mockResolvedValueOnce({ success: true, response: new Response("ok") });
    mocks.clearAccountError.mockClear();

    await handleTts(ttsRequest());

    expect(
      mocks.clearAccountError,
      "a successful no-auth request must resolve the breaker's probe",
    ).toHaveBeenCalled();
  });
});
