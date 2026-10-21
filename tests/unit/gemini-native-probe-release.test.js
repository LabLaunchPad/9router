/**
 * A probe that is claimed has to be released.
 *
 * `getProviderCredentials` calls `canRequest()`, and in the half-open state
 * that claims the single probe slot. The slot is released by
 * `recordSuccess()`, `recordFailure()` or `releaseProbe()` — and the only
 * production caller of `recordSuccess()` is `clearAccountError`.
 *
 * The gemini native route is the one path that returns to the client
 * directly instead of going through the account-failure path, so it has to
 * release the probe itself on every exit that produces no answer. Three
 * exits did not, and each of them left the provider half-open with its slot
 * held: every later request to that provider is refused for the whole reset
 * window, and every refusal is counted as an error against the error budget.
 *
 * The three exits:
 *
 *   - the client had already walked away before the request was sent (499),
 *   - the client walked away during the request (499),
 *   - the credential has no API key, so nothing was sent at all (404).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const authMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(async () => ({
    id: "gemini-conn",
    connectionId: "gemini-conn",
    connectionName: "Gemini",
    apiKey: "gemini-key",
    provider: "gemini",
    providerSpecificData: {},
  })),
  releaseProviderProbe: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false, cooldownMs: 0 })),
  clearAccountError: vi.fn(async () => {}),
  isValidApiKey: vi.fn(async () => true),
}));

vi.mock("@/sse/services/auth.js", () => authMocks);
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({ requireApiKey: false })) }));
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: vi.fn() }));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: vi.fn(async () => ({})),
  enforceKeyAccessResolved: vi.fn(async () => null),
}));
vi.mock("open-sse/translator/index.js", () => ({ initTranslators: vi.fn(async () => {}) }));

const { POST } = await import("../../src/app/api/v1beta/models/[...path]/route.js");

/** A gemini native TTS request — the path that talks to Gemini directly. */
function ttsRequest({ signal } = {}) {
  return new Request("https://example.test/v1beta/models/gemini-2.5-flash:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ generationConfig: { responseModalities: ["AUDIO"] } }),
    ...(signal ? { signal } : {}),
  });
}

const params = { params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }) };

beforeEach(() => {
  authMocks.releaseProviderProbe.mockClear();
  authMocks.markAccountUnavailable.mockClear();
  authMocks.getProviderCredentials.mockClear();
});

describe("the gemini native path releases the probe it claimed", () => {
  it("when the client had already walked away", async () => {
    const controller = new AbortController();
    controller.abort();

    const response = await POST(ttsRequest({ signal: controller.signal }), params);

    expect(response.status).toBe(499);
    expect(
      authMocks.releaseProviderProbe,
      "the probe claimed by the credential lookup has to be released",
    ).toHaveBeenCalledWith("gemini", 499, { upstreamContacted: false });
  });

  it("when the credential has no API key, so nothing was sent", async () => {
    authMocks.getProviderCredentials.mockResolvedValueOnce({
      id: "gemini-conn",
      connectionId: "gemini-conn",
      connectionName: "Gemini",
      provider: "gemini",
      providerSpecificData: {},
    });

    const response = await POST(ttsRequest(), params);

    expect(response.status).toBe(404);
    expect(
      authMocks.markAccountUnavailable,
      "a request that was never sent says nothing about the provider, and the probe has to be released",
    ).toHaveBeenCalledWith(
      "gemini-conn",
      404,
      "No Gemini API key configured",
      "gemini",
      "gemini-2.5-flash",
      { upstreamContacted: false },
    );
  });
});
