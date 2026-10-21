/**
 * The video core's retry after a refresh, and the fact it has to carry.
 *
 * The video core refreshes an OAuth credential once and retries once. When
 * the provider answers 401 or 403, the first attempt has already gone out:
 * the provider WAS asked, and it answered. If the RETRY then cannot be
 * planned — the refreshed credentials are not ones the request can be built
 * with — the failure the core returns is still about a provider that
 * answered.
 *
 * That fact is what the breaker reads, and getting it wrong is the unsafe
 * direction: a failure marked as one that never reached the provider
 * releases the probe as though the request had never left the building,
 * and counts an upstream answer as a local failure — which keeps a dead
 * provider in service.
 *
 * The status is the provider's own answer for the same reason. A literal
 * 4xx in a core is a failure the core raised on its own account, before
 * anything was sent; the scan in `local-failure-marking.test.js` holds the
 * fact to that convention, and the provider's answer is not a literal — it
 * is the status the provider sent.
 *
 * The adapter is mocked here because the plan error this test needs is the
 * one that only a credential-dependent adapter can raise: the first attempt
 * is planned with the credentials the account has, and the retry is planned
 * with the ones the refresh produced.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const buildRequest = vi.fn();

vi.mock("open-sse/handlers/videoProviders/index.js", () => ({
  getVideoAdapter: () => ({ buildRequest }),
}));

vi.mock("open-sse/services/tokenRefresh.js", () => ({
  refreshTokenByProvider: vi.fn(),
}));

import { handleVideoProxyCore } from "open-sse/handlers/videoCore.js";
import { refreshTokenByProvider } from "open-sse/services/tokenRefresh.js";

const originalFetch = global.fetch;

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const plan = { method: "POST", url: "https://video.test/generations", headers: {}, body: "{}" };

describe("the video core: the retry after a refresh", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    buildRequest.mockReset();
    refreshTokenByProvider.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("says the provider was asked when the retry cannot be planned", async () => {
    buildRequest
      .mockResolvedValueOnce(plan)
      .mockResolvedValueOnce({ error: "the refreshed credentials cannot be planned" });
    global.fetch.mockResolvedValueOnce(jsonResponse({ error: "expired" }, 401));
    refreshTokenByProvider.mockResolvedValueOnce({ accessToken: "tok-NEW" });

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      contentType: "application/json",
      credentials: { accessToken: "tok-OLD", refreshToken: "ref-OLD" },
    });

    expect(result.success).toBe(false);
    expect(
      result.upstreamContacted,
      "the first attempt went out and the provider answered — the fact has to say so",
    ).toBe(true);
    expect(
      result.status,
      "the status is the provider's own answer, not a local failure the core chose",
    ).toBe(401);
    expect(result.error).toContain("the refreshed credentials cannot be planned");
  });

  it("still says the provider was asked when the retry is planned and fails upstream", async () => {
    buildRequest.mockResolvedValue(plan);
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ error: "expired" }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: "upstream is down" }, 500));
    refreshTokenByProvider.mockResolvedValueOnce({ accessToken: "tok-NEW" });

    const result = await handleVideoProxyCore({
      provider: "xai",
      action: "generations",
      rawBody: "{}",
      contentType: "application/json",
      credentials: { accessToken: "tok-OLD", refreshToken: "ref-OLD" },
    });

    expect(result.status).toBe(500);
    expect(
      result.upstreamContacted,
      "the retry went out and the provider answered — the fact has to say so",
    ).toBe(true);
  });
});
