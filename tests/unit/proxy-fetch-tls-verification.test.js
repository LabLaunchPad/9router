// SEC-01 — open-sse/utils/proxyFetch.js fetchWithTlsFallback()
//
// The TLS-failure path used to retry automatically with an undici dispatcher
// built from `{ rejectUnauthorized: false }` unless the caller opted *in* to
// `strictTls` / `STRICT_SSL`. Certificate verification was therefore disabled
// BY DEFAULT: any certificate error (expired, self-signed, wrong host, untrusted
// CA) was silently retried over a connection that accepts any certificate — a
// MITM downgrade on the provider path.
//
// These tests pin the corrected behavior: a certificate validation failure is
// rejected, and no request is ever retried with verification disabled.
//
// Test seam: proxyFetch.js captures `globalThis.fetch` into `originalFetch` at
// module load and rebinds `globalThis.fetch` to its own patched wrapper on
// import. We stub `fetch` *before* the dynamic import so `originalFetch` binds
// to our spy and every underlying attempt is observable.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const tlsCertError = () =>
  Object.assign(new Error("self signed certificate in chain"), {
    code: "SELF_SIGNED_CERT_IN_CHAIN",
  });

describe("SEC-01: TLS certificate verification is never downgraded", () => {
  let mockFetch;
  let proxyAwareFetch;
  let seenOptions;

  beforeEach(async () => {
    seenOptions = [];
    mockFetch = vi.fn(async (_url, opts) => {
      seenOptions.push(opts);
      throw tlsCertError();
    });
    vi.stubGlobal("fetch", mockFetch);
    vi.resetModules();
    ({ proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects a certificate validation failure instead of retrying with verification disabled", async () => {
    const err = tlsCertError();
    mockFetch.mockImplementation(async (_url, opts) => {
      seenOptions.push(opts);
      throw err;
    });

    await expect(
      proxyAwareFetch("https://provider.example/v1/models", {})
    ).rejects.toBe(err);

    // A retry is a second underlying attempt. With no proxy configured, no
    // attempt may carry a dispatcher at all — the insecure retry passed
    // `{ dispatcher }` built from `rejectUnauthorized: false`.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(seenOptions).toHaveLength(1);
    expect(seenOptions[0]?.dispatcher).toBeUndefined();
  });

  it("propagates a non-TLS transport error on a single attempt", async () => {
    const err = new Error("socket hang up");
    mockFetch.mockImplementation(async (_url, opts) => {
      seenOptions.push(opts);
      throw err;
    });

    await expect(
      proxyAwareFetch("https://provider.example/v1/models", {})
    ).rejects.toBe(err);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns a successful response unchanged on a single attempt", async () => {
    mockFetch.mockImplementation(async (_url, opts) => {
      seenOptions.push(opts);
      return new Response("ok", { status: 200 });
    });

    const res = await proxyAwareFetch("https://provider.example/v1/models", {});
    expect(await res.text()).toBe("ok");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(seenOptions[0]?.dispatcher).toBeUndefined();
  });
});
