/**
 * A provider that needs no credential still has to be able to ask the
 * breaker whether it may be used.
 *
 * `getProviderCredentials` is where the breaker is consulted, so a path that
 * needs no credential has to go through it — but the lookup answers a
 * different question for such a provider: "is there a connection to use?".
 * There is not, and there never was, so the lookup returns null.
 *
 * A null that means "no connection configured" cannot be told apart from a
 * null that means "the circuit is open", and a caller that reads null as
 * "the circuit is open" refuses EVERY request to a local image server that
 * was never in trouble.
 *
 * `noCredentialRequired` is what separates the two: the lookup still
 * consults the breaker, and does not go looking for a connection.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/localDb", async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    // A provider that needs no credential has no connection to find.
    getProviderConnections: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({})),
    getProxyPools: vi.fn(async () => []),
  };
});

const { getProviderCredentials } = await import("../../src/sse/services/auth.js");
const {
  getCircuitBreaker,
  resetAllCircuitBreakers,
} = await import("../../open-sse/services/circuitBreaker.js");

// A local image server: it takes no credential, and the image handler is the
// path that asks for it.
const PROVIDER = "sdwebui";
const MODEL = "sdxl-base-1.0";

// The speech providers that take no credential. They are `category:
// "freeTier"`, so the lookup's synthetic-credential branch — which covers
// `category: "free"` — never matched them, and the lookup went looking for
// a connection they never have.
const SPEECH_PROVIDERS = ["edge-tts", "google-tts", "coqui", "tortoise", "local-device"];

beforeEach(() => {
  resetAllCircuitBreakers();
});

describe("the credential lookup for a provider that needs no credential", () => {
  it("hands back a credential instead of nothing", async () => {
    const creds = await getProviderCredentials(PROVIDER, null, MODEL, {
      noCredentialRequired: true,
    });

    expect(
      creds,
      "a provider that needs no credential still needs a gate, or every request is refused",
    ).toBeTruthy();
  });

  it("carries the provider, so the probe can be resolved on it", async () => {
    const creds = await getProviderCredentials(PROVIDER, null, MODEL, {
      noCredentialRequired: true,
    });

    expect(creds.provider).toBe(PROVIDER);
  });

  it("without the flag it finds no connection, and returns nothing", async () => {
    const creds = await getProviderCredentials(PROVIDER, null, MODEL);

    expect(creds, "this is the null the flag exists to avoid").toBeNull();
  });

  it("still consults the breaker: an open circuit refuses the request", async () => {
    const cb = getCircuitBreaker(PROVIDER, {
      failureThreshold: 1,
      coolDownWindowMs: 60000,
      resetWindowMs: 120000,
    });
    cb.recordFailure();
    expect(cb.state).toBe("open");

    const creds = await getProviderCredentials(PROVIDER, null, MODEL, {
      noCredentialRequired: true,
    });

    expect(creds, "an open circuit must refuse the request").toBeNull();
  });
});

describe("the credential lookup for a speech provider that needs no credential", () => {
  it("hands each of them a credential instead of nothing", async () => {
    for (const provider of SPEECH_PROVIDERS) {
      const creds = await getProviderCredentials(provider, null, "tts-1.0", {
        noCredentialRequired: true,
      });

      expect(
        creds,
        `${provider} takes no credential, so it still needs a gate, or every request is refused`,
      ).toBeTruthy();
    }
  });

  it("without the flag it finds no connection, and returns nothing", async () => {
    for (const provider of SPEECH_PROVIDERS) {
      const creds = await getProviderCredentials(provider, null, "tts-1.0");

      expect(creds, `${provider} is the null the flag exists to avoid`).toBeNull();
    }
  });

  it("the null is not a refusal: the circuit is closed", async () => {
    // The whole point of the flag. A null that means "no connection
    // configured" is read by the path as "the circuit is open", and the
    // path refuses the request — so a provider that was never in trouble is
    // refused for as long as it has no connection.
    const cb = getCircuitBreaker("edge-tts", {
      failureThreshold: 1,
      coolDownWindowMs: 60000,
      resetWindowMs: 120000,
    });
    expect(cb.state, "the circuit is closed").toBe("closed");

    const creds = await getProviderCredentials("edge-tts", null, "tts-1.0");

    expect(creds, "there is no connection to find").toBeNull();
    expect(cb.state, "and the circuit was never opened").toBe("closed");
  });
});
