import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
  })),
  getSettings: vi.fn(),
  validateApiKey: vi.fn(),
  getConsistentMachineId: vi.fn(),
  verifyDashboardAuthToken: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    next: vi.fn(() => mocks.nextResponse),
    json: mocks.jsonResponse,
    redirect: vi.fn((url) => ({ status: 307, url })),
  },
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
  validateApiKey: mocks.validateApiKey,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: mocks.getConsistentMachineId,
}));

vi.mock("@/lib/auth/dashboardSession", () => ({
  verifyDashboardAuthToken: mocks.verifyDashboardAuthToken,
}));

const { proxy, __test__ } = await import("../../src/dashboardGuard.js");

const PEER_TOKEN = "peer-token-fixture";

function request(pathname, headers = {}) {
  const normalizedHeaders = new Headers(headers);
  return {
    nextUrl: { pathname, searchParams: new URL(`http://localhost${pathname}`).searchParams },
    headers: normalizedHeaders,
    cookies: { get: vi.fn(() => undefined) },
    url: `http://localhost${pathname}`,
  };
}

// A request that actually came through custom-server.js: peer IP stamped from the TCP
// socket and proven by the per-process secret.
function localRequest(pathname, headers = {}) {
  return request(pathname, { "x-9r-peer-token": PEER_TOKEN, "x-9r-real-ip": "127.0.0.1", ...headers });
}

// Same, but carrying one cookie — the shape `proxy()` reads for `auth_token`.
function requestWithCookie(pathname, headers, name, value) {
  const base = localRequest(pathname, headers);
  return {
    ...base,
    cookies: { get: vi.fn((key) => (key === name ? { value } : undefined)) },
  };
}

describe("dashboard guard public LLM API access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("allows loopback public LLM API without API key", async () => {
    const response = await proxy(localRequest("/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote Host-spoof when real peer IP is non-loopback", async () => {
    const response = await proxy(localRequest("/v1/chat/completions", {
      host: "localhost",
      "x-9r-real-ip": "10.204.111.34",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback peer IP regardless of Host", async () => {
    const response = await proxy(localRequest("/v1/chat/completions", {
      host: "localhost:20128",
      "x-9r-real-ip": "127.0.0.1",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote rewritten public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1/chat/completions", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows loopback rewritten public LLM API without API key", async () => {
    const response = await proxy(localRequest("/api/v1/chat/completions", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).not.toHaveBeenCalled();
  });

  it("rejects remote beta public LLM API without API key", async () => {
    const response = await proxy(request("/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote rewritten beta public LLM API without API key", async () => {
    const response = await proxy(request("/api/v1beta/models", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote codex rewrite without API key", async () => {
    const response = await proxy(request("/codex/x", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("rejects remote /responses rewrite without API key", async () => {
    const response = await proxy(request("/responses", { host: "router.example.com" }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("API key required for remote API access");
  });

  it("allows remote /responses rewrite with a valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/responses", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote codex rewrite with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/codex/x", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid bearer API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1/chat/completions", {
      host: "router.example.com",
      authorization: "Bearer sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote public LLM API with valid x-api-key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1/web/fetch", {
      host: "router.example.com",
      "x-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote rewritten beta public LLM API with valid API key", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/api/v1beta/models", {
      host: "router.example.com",
      "x-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google API key header", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models", {
      host: "router.example.com",
      "x-goog-api-key": "sk-valid",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });

  it("allows remote beta public LLM API with valid Google key query parameter", async () => {
    mocks.validateApiKey.mockResolvedValue(true);

    const response = await proxy(request("/v1beta/models?key=sk-valid", {
      host: "router.example.com",
    }));

    expect(response).toBe(mocks.nextResponse);
    expect(mocks.validateApiKey).toHaveBeenCalledWith("sk-valid");
  });
});

describe("dashboard guard local-only access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("rejects local-only route from non-loopback host without CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("rejects local-only route on loopback when requireLogin=true and no JWT", async () => {
    const response = await proxy(localRequest("/api/mcp/filesystem/sse", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response.status).toBe(403);
    expect(response.body.error).toBe("Local only: CLI token required");
  });

  it("allows local-only route on loopback when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(localRequest("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("rejects local-only route from tunnel host even when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/api/cli-tools/antigravity-mitm", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("rejects local-only route when Origin is non-loopback (CSRF block)", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(localRequest("/api/cli-tools/antigravity-mitm", {
      host: "localhost:20128",
      origin: "http://evil.example.com",
    }));

    expect(response.status).toBe(403);
  });

  it("allows local-only route with valid CLI token", async () => {
    const response = await proxy(request("/api/mcp/filesystem/sse", {
      host: "router.example.com",
      "x-9r-cli-token": "cli-token",
    }));

    expect(response).toBe(mocks.nextResponse);
  });
});

describe("dashboard guard helpers", () => {
  it("extracts bearer API keys before x-api-key", () => {
    const apiRequest = request("/v1/chat/completions", {
      authorization: "Bearer bearer-key",
      "x-api-key": "header-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("bearer-key");
  });

  it("extracts Google API keys after x-api-key", () => {
    const apiRequest = request("/v1beta/models?key=query-key", {
      "x-api-key": "header-key",
      "x-goog-api-key": "google-key",
    });

    expect(__test__.extractApiKey(apiRequest)).toBe("header-key");
  });
});

// The surface below was previously untouched by this suite (it accounted for most
// of the module's un-covered mutants). Each case pins a branch in `proxy()` that
// decides whether a request is authenticated, redirected to /login, or waved
// through — i.e. the branches an authorization bypass would live in.
describe("dashboard guard deny-by-default API auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("rejects an unlisted /api/ route with no credentials", async () => {
    const response = await proxy(request("/api/not-in-the-allow-list", {
      host: "router.example.com",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Unauthorized");
  });

  it("allows an unlisted /api/ route with a valid dashboard JWT", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const response = await proxy(requestWithCookie("/api/not-in-the-allow-list", {
      host: "router.example.com",
    }, "auth_token", "signed-jwt"));

    expect(response).toBe(mocks.nextResponse);
  });

  it("allows an unlisted /api/ route on loopback when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(localRequest("/api/not-in-the-allow-list", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("lets a public allow-listed /api/ path through without auth", async () => {
    const response = await proxy(request("/api/health", { host: "router.example.com" }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("does not treat a look-alike public path as public", async () => {
    // "/api/healthz" is not "/api/health"; the allow-list matches the exact
    // path or a "path/" prefix, so this must fall through to auth.
    const response = await proxy(request("/api/healthz", { host: "router.example.com" }));

    expect(response.status).toBe(401);
  });

  it("rejects an ALWAYS_PROTECTED route with no credentials", async () => {
    const response = await proxy(request("/api/shutdown", {
      host: "localhost:20128",
      origin: "http://localhost:20128",
    }));

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Unauthorized");
  });

  it("allows an ALWAYS_PROTECTED route with a valid CLI token", async () => {
    const response = await proxy(request("/api/shutdown", {
      host: "localhost:20128",
      "x-9r-cli-token": "cli-token",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("allows an ALWAYS_PROTECTED route with a valid dashboard JWT", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const response = await proxy(requestWithCookie("/api/version/update", {
      host: "localhost:20128",
    }, "auth_token", "signed-jwt"));

    expect(response).toBe(mocks.nextResponse);
  });

  it("ignores a mismatched CLI token", async () => {
    const response = await proxy(request("/api/shutdown", {
      host: "localhost:20128",
      "x-9r-cli-token": "not-the-token",
    }));

    expect(response.status).toBe(401);
  });
});

describe("dashboard guard dashboard route protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("redirects an unauthenticated dashboard visit to /login", async () => {
    const response = await proxy(request("/dashboard/settings", { host: "localhost:20128" }));

    expect(response.status).toBe(307);
    expect(String(response.url)).toContain("/login");
  });

  it("allows a dashboard visit with a valid JWT", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(true);

    const response = await proxy(requestWithCookie("/dashboard", {
      host: "localhost:20128",
    }, "auth_token", "signed-jwt"));

    expect(response).toBe(mocks.nextResponse);
  });

  it("redirects a dashboard visit carrying an invalid JWT", async () => {
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);

    const response = await proxy(requestWithCookie("/dashboard", {
      host: "localhost:20128",
    }, "auth_token", "expired-jwt"));

    expect(response.status).toBe(307);
    expect(String(response.url)).toContain("/login");
  });

  it("allows a dashboard visit when requireLogin=false", async () => {
    mocks.getSettings.mockResolvedValue({ requireLogin: false });

    const response = await proxy(request("/dashboard", { host: "localhost:20128" }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("blocks the tunnel hostname on /dashboard when tunnel access is disabled", async () => {
    mocks.getSettings.mockResolvedValue({
      requireLogin: false,
      tunnelDashboardAccess: false,
      tunnelUrl: "https://abc.trycloudflare.com",
    });

    const response = await proxy(request("/dashboard", {
      host: "abc.trycloudflare.com",
    }));

    // Redirected to /login even though requireLogin is off — the tunnel block
    // wins, otherwise a public tunnel URL would expose the dashboard.
    expect(response.status).toBe(307);
    expect(String(response.url)).toContain("/login");
  });

  it("blocks the tailscale hostname on /dashboard when tunnel access is disabled", async () => {
    mocks.getSettings.mockResolvedValue({
      requireLogin: false,
      tunnelDashboardAccess: false,
      tailscaleUrl: "https://box.tailnet-abc.ts.net",
    });

    const response = await proxy(request("/dashboard", {
      host: "box.tailnet-abc.ts.net",
    }));

    expect(response.status).toBe(307);
    expect(String(response.url)).toContain("/login");
  });

  it("honours tunnelDashboardAccess=true for the tunnel hostname", async () => {
    mocks.getSettings.mockResolvedValue({
      requireLogin: false,
      tunnelDashboardAccess: true,
      tunnelUrl: "https://abc.trycloudflare.com",
    });

    const response = await proxy(request("/dashboard", {
      host: "abc.trycloudflare.com",
    }));

    expect(response).toBe(mocks.nextResponse);
  });

  it("keeps the secure defaults when reading settings throws", async () => {
    mocks.getSettings.mockRejectedValue(new Error("db unavailable"));

    const response = await proxy(request("/dashboard", { host: "localhost:20128" }));

    // loadSettings() swallows the error and returns null, so requireLogin stays
    // true: a broken DB must lock the dashboard, not open it.
    expect(response.status).toBe(307);
    expect(String(response.url)).toContain("/login");
  });
});

describe("dashboard guard routing fallthrough", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NINEROUTER_PEER_TOKEN = PEER_TOKEN;
    mocks.getSettings.mockResolvedValue({ requireLogin: true });
    mocks.validateApiKey.mockResolvedValue(false);
    mocks.getConsistentMachineId.mockResolvedValue("cli-token");
    mocks.verifyDashboardAuthToken.mockResolvedValue(false);
  });

  it("redirects the root path to /dashboard", async () => {
    const response = await proxy(request("/", { host: "localhost:20128" }));

    expect(response.status).toBe(307);
    expect(String(response.url)).toContain("/dashboard");
  });

  it("passes an unguarded path through untouched", async () => {
    const response = await proxy(request("/assets/logo.png", { host: "router.example.com" }));

    expect(response).toBe(mocks.nextResponse);
  });
});
