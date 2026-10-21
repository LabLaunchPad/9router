/**
 * The two xAI sign-in paths, end to end through the API the dashboard uses.
 *
 * xAI signs in one of two ways, and neither was covered:
 *
 *   1. THE SERVER-SIDE PATH. The dashboard starts the fixed-port callback
 *      proxy (56121) and registers the session, so the proxy can exchange
 *      the code itself and hand back a connection. The client then learns
 *      the result by polling the session.
 *
 *   2. THE MANUAL-CODE PATH. When the proxy cannot be used — the port is
 *      busy, or the popup was blocked — the user copies the code out of
 *      the browser and pastes it, and the server exchanges that code
 *      against the session it already holds.
 *
 * Both paths have a failure mode that is silent when it breaks: the
 * connection is simply never created, and the dashboard reports a
 * successful sign-in that has no connection behind it. The first path
 * fails that way if the session is not registered; the second fails it if
 * the pasted code is exchanged without the session's PKCE verifier.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({
      status: init?.status || 200,
      body,
      json: async () => body,
    }),
  },
}));

const exchangeTokens = vi.fn(async () => ({
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresIn: 3600,
}));

vi.mock("@/lib/oauth/providers", () => ({
  getProvider: vi.fn(),
  generateAuthData: vi.fn(),
  exchangeTokens,
  requestDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
}));

const createProviderConnection = vi.fn(async (d) => ({
  id: "conn-1",
  provider: d.provider,
  email: "user@example.com",
  displayName: "user@example.com",
}));

vi.mock("@/models", () => ({ createProviderConnection }));

vi.mock("open-sse/shared/mimoAccount.js", () => ({
  readDesktopPassToken: vi.fn(async () => ({})),
}));

vi.mock("@/lib/oauth/utils/ideDetect", () => ({ detectIdeInstalled: vi.fn() }));

// The session store, so the test can assert on real lifecycle transitions
// rather than on call counts alone.
const sessions = new Map();
const proxy = { started: [], stopped: 0 };

vi.mock("@/lib/oauth/utils/server", () => {
  const notUsed = () => {
    throw new Error("unexpected helper");
  };
  const noop = () => {};
  return {
    startCodexProxy: notUsed, stopCodexProxy: noop, registerCodexSession: noop,
    getCodexSessionStatus: () => null, clearCodexSession: noop,
    startXaiProxy: async (appPort) => {
      proxy.started.push(appPort);
      return { success: true };
    },
    stopXaiProxy: () => { proxy.stopped += 1; },
    registerXaiSession: ({ state, codeVerifier, redirectUri }) => {
      if (!state || !codeVerifier || !redirectUri) return false;
      sessions.set(state, { codeVerifier, redirectUri, status: "pending" });
      return true;
    },
    getXaiSessionStatus: (state) => sessions.get(state) || null,
    clearXaiSession: (state) => { sessions.delete(state); },
    startTraeProxy: notUsed, stopTraeProxy: noop, registerTraeSession: noop,
    getTraeSessionStatus: () => null, clearTraeSession: noop,
    startWindsurfProxy: notUsed, stopWindsurfProxy: noop, registerWindsurfSession: noop,
    getWindsurfSessionStatus: () => null, clearWindsurfSession: noop,
    startZedProxy: notUsed, stopZedProxy: noop, registerZedSession: noop,
    getZedSessionStatus: () => null, clearZedSession: noop,
    startXiaomiMimoProxy: notUsed, stopXiaomiMimoProxy: noop,
    registerXiaomiMimoSession: noop,
    getXiaomiMimoSessionStatus: () => null,
    clearXiaomiMimoSession: noop,
  };
});

const { GET, POST } = await import("../../src/app/api/oauth/[provider]/[action]/route.js");

const REDIRECT = "http://127.0.0.1:56121/callback";

const startProxy = (query = `app_port=20127&state=st1&code_verifier=verifier-1&redirect_uri=${encodeURIComponent(REDIRECT)}`) =>
  GET(new Request(`http://localhost/api/oauth/xai/start-proxy?${query}`), {
    params: Promise.resolve({ provider: "xai", action: "start-proxy" }),
  });

const pollStatus = (state) =>
  GET(new Request(`http://localhost/api/oauth/xai/poll-status?state=${state}`), {
    params: Promise.resolve({ provider: "xai", action: "poll-status" }),
  });

const manualCode = (code, state) =>
  POST(
    new Request("http://localhost/api/oauth/xai/manual-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, state }),
    }),
    { params: Promise.resolve({ provider: "xai", action: "manual-code" }) },
  );

describe("xAI sign-in", () => {
  beforeEach(() => {
    sessions.clear();
    proxy.started = [];
    proxy.stopped = 0;
    exchangeTokens.mockClear();
    createProviderConnection.mockClear();
  });

  it("server-side: the session is registered, and the client can read the result", async () => {
    const start = await startProxy();

    expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({ success: true, serverSide: true });
    expect(proxy.started).toEqual([20127]);
    expect(sessions.get("st1")).toMatchObject({
      status: "pending",
      codeVerifier: "verifier-1",
      redirectUri: REDIRECT,
    });

    // The proxy exchanges the code itself and records the outcome on the
    // session; the client learns it by polling.
    const session = sessions.get("st1");
    session.status = "done";
    session.connectionId = "conn-1";
    session.email = "user@example.com";

    const poll = await pollStatus("st1");

    expect(poll.status).toBe(200);
    expect(await poll.json()).toMatchObject({
      status: "done",
      connectionId: "conn-1",
      email: "user@example.com",
    });
    // A finished session is consumed by the poll that read it.
    expect(sessions.has("st1")).toBe(false);
  });

  it("manual code: the pasted code is exchanged against the session, and the connection is created", async () => {
    await startProxy();

    const res = await manualCode("auth-code", "st1");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      connection: { id: "conn-1", provider: "xai" },
    });
    // The code is exchanged with the verifier and the redirect the session
    // holds — a code exchanged without them is not a code xAI will accept.
    expect(exchangeTokens).toHaveBeenCalledWith("xai", "auth-code", REDIRECT, "verifier-1", "st1");
    expect(createProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "xai", authType: "oauth", accessToken: "access-token" })
    );
    // The session is consumed and the proxy is stopped, so the next sign-in
    // starts from a clean server.
    expect(sessions.has("st1")).toBe(false);
    expect(proxy.stopped).toBe(1);

    // A code pasted for a session that is not there is refused, and it does
    // not create a connection.
    const orphan = await manualCode("auth-code", "no-such-state");

    expect(orphan.status).toBe(500);
    expect((await orphan.json()).error).toMatch(/session not found/i);
    expect(createProviderConnection).toHaveBeenCalledTimes(1);
  });
});
