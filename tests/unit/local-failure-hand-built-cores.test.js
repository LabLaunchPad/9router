/**
 * The cores that build their results by hand.
 *
 * The search and fetch cores assemble their failure results as object
 * literals rather than through the error constructor, which is how their
 * local failures came to be unmarked: the breaker's default is "the
 * provider was contacted", and a local failure that does not say otherwise
 * closes the half-open circuit as though the provider had replied.
 *
 * The scan in `local-failure-marking.test.js` proves that every such site
 * is marked. These tests drive them, because a scan proves the shape and
 * only a call proves the behaviour.
 */

import { describe, expect, it } from "vitest";
import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";
import { handleChatSearch } from "../../open-sse/handlers/search/chatSearch.js";

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
