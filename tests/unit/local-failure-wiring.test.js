/**
 * The "the provider was never asked anything" fact has to survive the trip
 * from the core to the breaker.
 *
 * Two things have to be true, and they live in different layers:
 *
 *   - the CORE has to say it. The core is the only place that knows whether
 *     an upstream call was made: it validates the request and builds the body
 *     before it fetches anything. A failure raised there is a local failure,
 *     and the result carries `upstreamContacted: false`.
 *   - the HANDLER has to pass it on. The handler is the only thing that
 *     talks to both the core and the breaker, so the fact has to cross it.
 *
 * A test of either half alone would pass while the chain was broken, which
 * is the shape this branch's reviews have kept finding: a control that
 * exists, is tested in isolation, and is not connected to the path it claims
 * to govern.
 *
 * The handler half is guarded two ways. The behavioural tests below drive a
 * handler and assert that the fact reaches the breaker — one of them for
 * the embeddings path and one for the search path, which is the path round
 * 14 broke. The scan below covers the rest: every call site that hands a
 * failure to the breaker has to state the fact, so a handler cannot drop it
 * by accident. The behavioural tests prove the VALUE; the scan proves that
 * no call site is left to the default.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const authMocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(async () => ({
    id: "conn-1",
    connectionId: "conn-1",
    connectionName: "Test",
    accessToken: "tok-1",
    apiKey: "key-1",
    provider: "openai",
    providerSpecificData: {},
  })),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false, cooldownMs: 0 })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));

const coreMocks = vi.hoisted(() => ({
  handleEmbeddingsCore: vi.fn(),
  handleSearchCore: vi.fn(),
}));

vi.mock("@/sse/services/auth.js", () => authMocks);
vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
  getCombos: vi.fn(async () => []),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => ({ provider: "openai", model: "text-embedding-3-small" })),
}));
vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: vi.fn(async () => ({})),
  enforceKeyAccessResolved: vi.fn(async () => null),
  enforceKeyAccessProvider: vi.fn(async () => null),
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: vi.fn(async (_p, creds) => creds),
  updateProviderCredentials: vi.fn(async () => {}),
}));
vi.mock("@/sse/services/combo.js", () => ({
  handleComboChat: vi.fn(),
  getComboModelsFromData: vi.fn(() => null),
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn(async () => {}) }));
vi.mock("open-sse/handlers/embeddingsCore.js", () => coreMocks);
vi.mock("open-sse/handlers/search/index.js", () => coreMocks);
vi.mock("@/shared/constants/providers.js", () => ({
  AI_PROVIDERS: { openai: { searchConfig: { authType: "bearer" } } },
  resolveProviderId: (id) => id,
}));

const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
const { handleSearch } = await import("../../src/sse/handlers/search.js");
// The real core, for the two cases that are about what the core produces.
// The handler drives the mocked one, so that the two halves of the chain
// are tested against the same contract.
const { handleEmbeddingsCore } = await vi.importActual("open-sse/handlers/embeddingsCore.js");

const request = () =>
  new Request("http://localhost/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: "hello" }),
  });

const searchRequest = () =>
  new Request("http://localhost/v1/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "openai", query: "hello" }),
  });

beforeEach(() => {
  authMocks.markAccountUnavailable.mockClear();
  coreMocks.handleEmbeddingsCore.mockReset();
  coreMocks.handleSearchCore.mockReset();
});

describe("the core says whether the provider was contacted", () => {
  it("marks a request it never sent as not contacted", async () => {
    const result = await handleEmbeddingsCore({
      body: {},
      modelInfo: { provider: "openai", model: "text-embedding-3-small" },
      credentials: { apiKey: "key-1" },
      log: { debug: () => {} },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(
      result.upstreamContacted,
      "a request that failed validation never reached the provider",
    ).toBe(false);
  });

  it("marks a request it could not build as not contacted", async () => {
    // A provider with no embeddings adapter: the core answers 400 without
    // fetching anything.
    const result = await handleEmbeddingsCore({
      body: { input: "hello" },
      modelInfo: { provider: "not-a-provider", model: "some-model" },
      credentials: { apiKey: "key-1" },
      log: { debug: () => {} },
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.upstreamContacted).toBe(false);
  });
});

describe("the handler passes it on", () => {
  it("tells the breaker that the provider was never contacted", async () => {
    coreMocks.handleEmbeddingsCore.mockResolvedValueOnce({
      success: false,
      status: 400,
      error: "Missing required field: input",
      upstreamContacted: false,
    });

    await handleEmbeddings(request());

    expect(
      authMocks.markAccountUnavailable,
      "the local-failure fact has to reach the account-failure path",
    ).toHaveBeenCalledWith(
      "conn-1",
      400,
      "Missing required field: input",
      "openai",
      "text-embedding-3-small",
      { upstreamContacted: false },
    );
  });

  it("tells the breaker that the provider was never contacted, on the search path", async () => {
    // The search path is the one round 14 broke: the core marked the
    // failure and the wrapper threw the marking away. The handler is the
    // layer that reads the fact, so it is the layer that has to be proven
    // on this path too.
    coreMocks.handleSearchCore.mockResolvedValueOnce({
      success: false,
      status: 400,
      error: "Query contains invalid control characters",
      upstreamContacted: false,
    });

    await handleSearch(searchRequest());

    expect(
      authMocks.markAccountUnavailable,
      "the local-failure fact has to reach the account-failure path",
    ).toHaveBeenCalledWith(
      "conn-1",
      400,
      "Query contains invalid control characters",
      "openai",
      "websearch:openai",
      { upstreamContacted: false },
    );
  });

  it("assumes the provider was contacted when the core does not say", async () => {
    // An upstream failure: the provider WAS asked, and it answered with a
    // 502. The fact is absent, and the default has to be "contacted" — the
    // upstream case is the one that was already right.
    coreMocks.handleEmbeddingsCore.mockResolvedValueOnce({
      success: false,
      status: 502,
      error: "upstream failed",
    });

    await handleEmbeddings(request());

    expect(authMocks.markAccountUnavailable).toHaveBeenCalledWith(
      "conn-1",
      502,
      "upstream failed",
      "openai",
      "text-embedding-3-small",
      { upstreamContacted: true },
    );
  });
});

/**
 * Every place a handler hands a failure to the breaker.
 *
 * The call has to state the fact. Leaving it to the default means the
 * handler's author has to know what the default is and that it happens to
 * be right for this call — and the failure that gets it wrong is silent:
 * a local failure is read as "the provider ANSWERED", the half-open circuit
 * closes, and a provider that is still down is declared healthy.
 *
 * The scan cannot tell a hard-coded `true` from the fact read off the
 * result; the behavioural tests above are what prove the value. What this
 * proves is that no call site is left to the default at all.
 */
const SRC_DIR = path.join(process.cwd(), "src");

function breakerCallSites() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".js")) {
        const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
        lines.forEach((line, i) => {
          if (!/markAccountUnavailable\s*\(/.test(line)) return;
          // The definition is not a call site.
          if (/function\s+markAccountUnavailable/.test(line)) return;
          // A comment is not a call site.
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;

          // The call's arguments: the statement the call sits in.
          const parts = [line];
          if (!line.includes(");")) {
            for (let j = i + 1; j < lines.length && j <= i + 12; j += 1) {
              parts.push(lines[j]);
              if (lines[j].includes(");")) break;
            }
          }
          const call = parts.join("\n");

          found.push({
            file: path.relative(process.cwd(), full).replace(/\\/g, "/"),
            line: i + 1,
            text: trimmed,
            states: call.includes("upstreamContacted"),
          });
        });
      }
    }
  };
  walk(SRC_DIR);
  return found;
}

describe("the handler layer: every call states the fact", () => {
  it("finds the call sites, so the check below is not vacuous", () => {
    const sites = breakerCallSites();
    expect(sites.length).toBeGreaterThan(0);
    // The call sites are pinned: the handlers and the gemini native route.
    // They are the ones that hand a failure to the breaker, and a file
    // that stops appearing here is a file that has stopped being covered.
    expect(sites.map((s) => s.file)).toContain("src/sse/handlers/chat.js");
    expect(sites.map((s) => s.file)).toContain("src/sse/handlers/search.js");
    expect(sites.map((s) => s.file)).toContain("src/app/api/v1beta/models/[...path]/route.js");
  });

  it("has no call that leaves the fact to the default", () => {
    const silent = breakerCallSites()
      .filter((s) => !s.states)
      .map((s) => `${s.file}:${s.line}  ${s.text}`);

    expect(
      silent,
      `these calls hand a failure to the breaker without saying whether the provider was contacted: ${silent.join(" | ")}`,
    ).toEqual([]);
  });
});
