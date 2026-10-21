/**
 * The search core's failures have to say whether the provider was asked.
 *
 * The dedicated path reports every failure it produces, and one of the
 * failures it can produce is our own SSRF guard refusing the URL before
 * anything was sent. That is a LOCAL failure: the request never left the
 * building, so it says nothing about the provider.
 *
 * It used to be reported the way a transport error is — a 502 with the
 * fact "the provider was asked" — and 502 is a provider-level failure, so
 * the breaker counted it against the provider. A provider that never
 * received a request could have its circuit opened by a URL our own guard
 * refused.
 *
 * The guard's rejection carries a code now, so the core can tell it from a
 * transport error without matching on the message.
 */

import { describe, expect, it, vi } from "vitest";
import { handleSearchCore } from "open-sse/handlers/search/index.js";

const provider = {
  id: "demo-search",
  searchConfig: {
    baseUrl: "http://localhost:8888/search",
    method: "GET",
    authType: "none",
    authHeader: "none",
    searchTypes: ["web"],
    defaultMaxResults: 5,
    maxMaxResults: 10,
    timeoutMs: 2000,
  },
};

const log = { info: vi.fn(), error: vi.fn() };

describe("the search core: the SSRF guard's rejection is a local failure", () => {
  it("says the provider was never asked, and carries a local status", async () => {
    const result = await handleSearchCore({
      body: { query: "hello" },
      provider,
      providerConfig: provider.searchConfig,
      credentials: {},
      log,
    });

    expect(result.success).toBe(false);
    // The guard refused the URL, so the request never left the building.
    expect(result.upstreamContacted).toBe(false);
    // A local failure carries a local status: a 4xx is not a provider-level
    // failure, and the breaker tells the two apart by the status.
    expect(result.status).toBe(400);
    expect(result.error).toContain("Blocked URL");
  });

  it("still reports a transport error as an upstream failure", async () => {
    const result = await handleSearchCore({
      body: { query: "hello" },
      provider: { ...provider, id: "demo-public" },
      providerConfig: {
        ...provider.searchConfig,
        baseUrl: "https://search.invalid.example/search",
      },
      credentials: {},
      log,
    });

    expect(result.success).toBe(false);
    // The request went out and the fetch failed: the provider was asked.
    expect(result.upstreamContacted).toBe(true);
    expect(result.status).toBe(502);
  });

  it("reports a refused REDIRECT as an upstream failure — the first hop went out", async () => {
    // The provider answered with a redirect to an internal target. The
    // first hop went out and the provider answered, so refusing the second
    // hop does not make the request local: the provider was asked.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://localhost:8888/search" },
        }),
      ),
    );

    try {
      const result = await handleSearchCore({
        body: { query: "hello" },
        provider: { ...provider, id: "demo-redirect" },
        providerConfig: {
          ...provider.searchConfig,
          // A literal public address: no DNS lookup, so the test does not
          // depend on a resolver.
          baseUrl: "https://8.8.8.8/search",
        },
        credentials: {},
        log,
      });

      expect(result.success).toBe(false);
      expect(result.upstreamContacted).toBe(true);
      expect(result.status).toBe(502);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
