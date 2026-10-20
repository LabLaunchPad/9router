/**
 * The cores that build their results by hand.
 *
 * The search and fetch cores assemble their failure results as object
 * literals rather than through the error constructor, which is how their
 * local failures came to be unmarked: the breaker's default is "the
 * provider was contacted", and a local failure that does not say otherwise
 * closes the half-open circuit as though the provider had replied.
 *
 * These tests drive the cores' PUBLIC entry points, and they assert on the
 * result the core RETURNS.
 *
 * That is the point. The search core does not return the result it is
 * given — it wraps it, and a wrapper that rebuilds the result without
 * carrying the fact turns every local failure back into "the provider
 * ANSWERED". A test that asserted on the inner result, one layer below
 * the wrapper, passed while the path was still broken: the fact was
 * correct at the producer and gone at the consumer.
 *
 * The scan in `local-failure-marking.test.js` is the cheap second net. This
 * file is the control.
 */

import { describe, expect, it } from "vitest";
import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";
import { handleChatSearch } from "../../open-sse/handlers/search/chatSearch.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

describe("the fetch core: a request that never reached the provider", () => {
  it("marks a missing url", async () => {
    const result = await handleFetchCore({
      url: "",
      provider: "jina-reader",
      providerConfig: {},
      credentials: {},
      log,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(
      result.upstreamContacted,
      "the request was never sent, so the provider was never asked anything",
    ).toBe(false);
  });

  it("marks a missing provider", async () => {
    const result = await handleFetchCore({
      url: "https://example.test/article",
      provider: "",
      providerConfig: {},
      credentials: {},
      log,
    });

    expect(result.status).toBe(400);
    expect(result.upstreamContacted).toBe(false);
  });

  it("marks an unsupported provider", async () => {
    const result = await handleFetchCore({
      url: "https://example.test/article",
      provider: "not-a-provider",
      providerConfig: {},
      credentials: {},
      log,
    });

    expect(result.status).toBe(400);
    expect(result.upstreamContacted).toBe(false);
  });

  it("marks an unsupported format", async () => {
    const result = await handleFetchCore({
      url: "https://example.test/article",
      format: "not-a-format",
      provider: "tinyfish",
      providerConfig: {},
      credentials: {},
      log,
    });

    expect(result.status).toBe(400);
    expect(result.upstreamContacted).toBe(false);
  });
});

describe("the chat-search core: a request that never reached the provider", () => {
  it("marks an unsupported provider", async () => {
    const result = await handleChatSearch({
      provider: "not-a-provider",
      query: "hello",
      credentials: { apiKey: "key" },
      log,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.upstreamContacted).toBe(false);
  });

  it("marks a missing query", async () => {
    const result = await handleChatSearch({
      provider: "perplexity",
      query: "",
      credentials: { apiKey: "key" },
      log,
    });

    expect(result.status).toBe(400);
    expect(result.upstreamContacted).toBe(false);
  });

  it("marks missing credentials", async () => {
    const result = await handleChatSearch({
      provider: "perplexity",
      query: "hello",
      credentials: {},
      log,
    });

    expect(result.status).toBe(401);
    expect(
      result.upstreamContacted,
      "a missing credential is a local problem — the provider was never asked anything",
    ).toBe(false);
  });
});

describe("the search core: the fact has to survive the wrapper", () => {
  it("marks a query that cannot be sanitized", async () => {
    const result = await handleSearchCore({
      body: { query: "bad\u0000query" },
      provider: { id: "p" },
      providerConfig: { authType: "none" },
      credentials: {},
      log,
    });

    expect(result.status).toBe(400);
    expect(result.error).toContain("control characters");
    expect(result.upstreamContacted).toBe(false);
  });

  it("marks a provider that does not support web search", async () => {
    const result = await handleSearchCore({
      body: { query: "hello" },
      provider: { id: "p" },
      providerConfig: null,
      credentials: {},
      log,
    });

    expect(result.status).toBe(400);
    expect(result.upstreamContacted).toBe(false);
  });

  it("marks a dedicated provider with no credentials", async () => {
    const result = await handleSearchCore({
      body: { query: "hello" },
      provider: { id: "p" },
      providerConfig: { authType: "bearer" },
      credentials: {},
      log,
    });

    expect(result.status).toBe(401);
    expect(
      result.upstreamContacted,
      "the search core wraps the provider's result — the fact has to survive the wrap",
    ).toBe(false);
  });

  it("marks a chat-search provider with no credentials", async () => {
    const result = await handleSearchCore({
      body: { query: "hello" },
      provider: { id: "gemini", searchViaChat: { defaultModel: "gemini-2.5-flash" } },
      providerConfig: null,
      credentials: {},
      log,
    });

    expect(result.status).toBe(401);
    expect(
      result.upstreamContacted,
      "the chat-search core's result is wrapped too — the fact has to survive the wrap",
    ).toBe(false);
  });
});

/**
 * The other direction.
 *
 * Everything above says what a failure that never reached the provider has
 * to say. This says what a failure the provider ANSWERED has to say, and
 * that direction is the one that was not asserted anywhere: a core that
 * marked its upstream failures as ones that never left the building would
 * pass every other test in this file.
 *
 * The consequence is the unsafe one. The breaker reads "the request never
 * reached the provider" as a local problem: the probe is released, nothing
 * is recorded against the provider, and the circuit never opens. A provider
 * that is down keeps taking traffic, and the only trace is a counter that
 * says the requests never left the building.
 */

/** A response the upstream "sent": an error, with a body. */
function upstreamError(status, message) {
  return {
    ok: false,
    status,
    headers: { get: () => "application/json" },
    json: async () => ({ error: { message } }),
    text: async () => message,
  };
}

/** Run a body with the global fetch replaced by an upstream that failed. */
async function withUpstreamFailure(status, message, body) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => upstreamError(status, message);
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

describe("the cores: a failure the provider ANSWERED has to say so", () => {
  it("marks the fetch core's upstream failure as one the provider answered", async () => {
    const result = await withUpstreamFailure(500, "upstream is down", () =>
      handleFetchCore({
        url: "https://example.test/article",
        provider: "tinyfish",
        providerConfig: { baseUrl: "https://tiny.test/scrape" },
        credentials: { apiKey: "k" },
        log,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe(500);
    expect(
      result.upstreamContacted,
      "the request was sent and the provider answered with a 500 — the fact has to say so",
    ).toBe(true);
  });

  it("marks the chat-search core's upstream failure as one the provider answered", async () => {
    const result = await withUpstreamFailure(500, "upstream is down", () =>
      handleChatSearch({
        provider: "perplexity",
        query: "hello",
        credentials: { apiKey: "k" },
        log,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe(500);
    expect(
      result.upstreamContacted,
      "the request was sent and the provider answered with a 500 — the fact has to say so",
    ).toBe(true);
  });

  it("marks the search core's upstream failure as one the provider answered", async () => {
    const result = await withUpstreamFailure(500, "upstream is down", () =>
      handleSearchCore({
        body: { query: "hello" },
        provider: { id: "perplexity", searchViaChat: { defaultModel: "sonar" } },
        providerConfig: null,
        credentials: { apiKey: "k" },
        log,
      }),
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe(500);
    expect(
      result.upstreamContacted,
      "the search core wraps the provider's result — the fact has to survive the wrap",
    ).toBe(true);
  });
});
