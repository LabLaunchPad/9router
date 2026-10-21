/**
 * The no-auth paths have to pass the fact on too.
 *
 * A provider with no credentials has no account to lock, so its failure
 * goes to the breaker directly — `recordProviderFailure` — instead of
 * through `markAccountUnavailable`. That call has the same obligation as
 * every other one: it has to say whether the provider was asked.
 *
 * The fact matters most here, because the failure on this path is very
 * often LOCAL: the client forgot to send the text, and the core answered
 * before it called anything. Left to the default, that local failure is
 * reported to the breaker as "the provider ANSWERED 400" — and a 4xx on a
 * half-open circuit resolves the probe as a SUCCESS, so one malformed
 * request closes the circuit of a provider that is still down.
 *
 * The scan in `local-failure-wiring.test.js` proves that every call site
 * states the fact. This proves the VALUE at the two call sites that were
 * not covered by it.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const authMocks = vi.hoisted(() => ({
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
  getProviderCredentials: vi.fn(async () => ({
    id: "noauth",
    connectionId: "noauth",
    connectionName: "No auth",
    provider: "edge-tts",
    providerSpecificData: {},
  })),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false, cooldownMs: 0 })),
  clearAccountError: vi.fn(async () => {}),
  recordProviderFailure: vi.fn(() => false),
}));

const coreMocks = vi.hoisted(() => ({
  handleTtsCore: vi.fn(),
  handleSttCore: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => authMocks);
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
  getCustomModels: vi.fn(async () => []),
  getCombos: vi.fn(async () => []),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "edge-tts", model: "edge-tts-voice" })),
  getComboModels: vi.fn(() => null),
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: vi.fn(async () => ({})),
  enforceKeyAccess: vi.fn(async () => null),
  enforceKeyAccessResolved: vi.fn(async () => null),
  enforceKeyAccessProvider: vi.fn(async () => null),
}));
vi.mock("open-sse/handlers/ttsCore.js", () => coreMocks);
vi.mock("open-sse/handlers/sttCore.js", () => coreMocks);
vi.mock("open-sse/services/combo.js", () => ({
  handleComboChat: vi.fn(),
  getComboModelsFromData: vi.fn(() => null),
}));
vi.mock("@/shared/constants/providers", () => ({
  // A provider with no credentials: it takes the no-auth path, which is the
  // path that talks to the breaker directly.
  AI_PROVIDERS: {
    "edge-tts": {
      serviceKinds: ["tts"],
      noAuth: true,
      ttsConfig: { authType: "none" },
    },
  },
  resolveProviderId: (id) => id,
}));

const { handleTts } = await import("../../src/sse/handlers/tts.js");
const { handleStt } = await import("../../src/sse/handlers/stt.js");

const ttsRequest = () =>
  new Request("http://localhost/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "edge-tts/edge-tts-voice", input: "hello" }),
  });

const sttRequest = () => {
  const form = new FormData();
  form.append("model", "edge-tts/edge-tts-voice");
  form.append("file", new Blob(["audio"], { type: "audio/wav" }), "a.wav");
  return new Request("http://localhost/v1/audio/transcriptions", { method: "POST", body: form });
};

beforeEach(() => {
  authMocks.recordProviderFailure.mockClear();
  coreMocks.handleTtsCore.mockReset();
  coreMocks.handleSttCore.mockReset();
});

describe("the no-auth TTS path: the fact reaches the breaker", () => {
  it("says the provider was never asked when the core failed before the call", async () => {
    coreMocks.handleTtsCore.mockResolvedValueOnce({
      success: false,
      status: 400,
      error: "Missing required field: input",
      upstreamContacted: false,
    });

    await handleTts(ttsRequest());

    expect(authMocks.recordProviderFailure).toHaveBeenCalledWith("edge-tts", 400, {
      upstreamContacted: false,
    });
  });

  it("says the provider was asked when the core got an answer", async () => {
    coreMocks.handleTtsCore.mockResolvedValueOnce({
      success: false,
      status: 502,
      error: "upstream failed",
      upstreamContacted: true,
    });

    await handleTts(ttsRequest());

    expect(authMocks.recordProviderFailure).toHaveBeenCalledWith("edge-tts", 502, {
      upstreamContacted: true,
    });
  });
});

describe("the no-auth STT path: the fact reaches the breaker", () => {
  it("says the provider was never asked when the core failed before the call", async () => {
    coreMocks.handleSttCore.mockResolvedValueOnce({
      success: false,
      status: 400,
      error: "Missing required field: file",
      upstreamContacted: false,
    });

    await handleStt(sttRequest());

    expect(authMocks.recordProviderFailure).toHaveBeenCalledWith("edge-tts", 400, {
      upstreamContacted: false,
    });
  });
});
