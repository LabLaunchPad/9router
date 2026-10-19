import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

// The module resolves DATA_DIR at import time; point it at a temp dir first.
const TMP_DIR = path.join(os.tmpdir(), `9router-state-test-${process.pid}`);
process.env.SSE_STATE_DIR = TMP_DIR;

const {
  buildSnapshot,
  writeSnapshot,
  writeSnapshotSync,
  readSnapshot,
  restoreSnapshot,
  persistNow,
  registerStatePersistence,
  __resetForTests,
  STATE_PERSISTENCE_CONFIG,
  STATE_VERSION,
} = await import("../../src/sse/services/state-persistence.js");

// --- helpers ---------------------------------------------------------------

function freshGlobals(overrides = {}) {
  return {
    _pendingRequests: { byModel: {}, byAccount: {} },
    _lastErrorProvider: { provider: "", ts: 0 },
    _recentRing: { items: [], initialized: false },
    ...overrides,
  };
}

beforeEach(async () => {
  __resetForTests();
  await fs.rm(TMP_DIR, { recursive: true, force: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  __resetForTests();
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

// --- buildSnapshot ---------------------------------------------------------

describe("buildSnapshot", () => {
  it("captures pending request counts", () => {
    const g = freshGlobals();
    g._pendingRequests.byModel["gpt-4o|openai"] = 3;
    const snap = buildSnapshot(g);
    expect(snap.pendingRequests.byModel["gpt-4o|openai"]).toBe(3);
  });

  it("drops non-positive pending counts", () => {
    const g = freshGlobals();
    g._pendingRequests.byModel["a|b"] = 0;
    g._pendingRequests.byModel["c|d"] = -2;
    const snap = buildSnapshot(g);
    expect(snap.pendingRequests.byModel["a|b"]).toBeUndefined();
    expect(snap.pendingRequests.byModel["c|d"]).toBeUndefined();
  });

  it("captures the last error provider", () => {
    const g = freshGlobals();
    g._lastErrorProvider = { provider: "openai", ts: 1700000000000 };
    const snap = buildSnapshot(g);
    expect(snap.lastErrorProvider.provider).toBe("openai");
    expect(snap.lastErrorProvider.ts).toBe(1700000000000);
  });

  it("omits the last error provider when empty", () => {
    const snap = buildSnapshot(freshGlobals());
    expect(snap.lastErrorProvider).toBeNull();
  });

  it("records the version and a persisted-at timestamp", () => {
    const snap = buildSnapshot(freshGlobals());
    expect(snap.version).toBe(STATE_VERSION);
    expect(Number.isNaN(Date.parse(snap.persistedAt))).toBe(false);
  });

  it("records process uptime", () => {
    const snap = buildSnapshot(freshGlobals());
    expect(typeof snap.uptimeSeconds).toBe("number");
    expect(snap.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("does not include the ring buffer by default", () => {
    const g = freshGlobals();
    g._recentRing.items = [{ timestamp: "2024-01-01", provider: "openai", apiKey: "sk-secret" }];
    const snap = buildSnapshot(g);
    expect(snap.recentRing).toBeNull();
  });

  it("tolerates missing globals", () => {
    const snap = buildSnapshot({});
    expect(snap.pendingRequests).toEqual({ byModel: {}, byAccount: {} });
    expect(snap.lastErrorProvider).toBeNull();
  });
});

// --- secret exclusion ------------------------------------------------------

describe("buildSnapshot: secret exclusion", () => {
  it("never writes an apiKey even when the ring buffer is enabled", async () => {
    const prev = STATE_PERSISTENCE_CONFIG.persistRecentRing;
    STATE_PERSISTENCE_CONFIG.persistRecentRing = true;
    try {
      const g = freshGlobals();
      g._recentRing.items = [
        {
          timestamp: "2024-01-01T00:00:00Z",
          provider: "openai",
          model: "gpt-4o",
          connectionId: "conn-1",
          endpoint: "/v1/chat/completions",
          status: 200,
          cost: 0.01,
          tokens: { prompt_tokens: 10, completion_tokens: 5 },
          apiKey: "sk-super-secret-value",
          authorization: "Bearer abc123",
          headers: { "x-api-key": "sk-leak" },
          requestBody: { messages: [{ role: "user", content: "my prompt" }] },
        },
      ];
      const snap = buildSnapshot(g);
      const serialised = JSON.stringify(snap);
      expect(serialised).not.toContain("sk-super-secret-value");
      expect(serialised).not.toContain("sk-leak");
      expect(serialised).not.toContain("Bearer abc123");
      expect(serialised).not.toContain("my prompt");
      // Allowed operational fields survive.
      expect(snap.recentRing.items[0].provider).toBe("openai");
      expect(snap.recentRing.items[0].tokens).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    } finally {
      STATE_PERSISTENCE_CONFIG.persistRecentRing = prev;
    }
  });

  it("keeps only numeric token leaves", () => {
    const prev = STATE_PERSISTENCE_CONFIG.persistRecentRing;
    STATE_PERSISTENCE_CONFIG.persistRecentRing = true;
    try {
      const g = freshGlobals();
      g._recentRing.items = [{ tokens: { prompt_tokens: 5, secret: "abc", nested: { x: 1 } } }];
      const snap = buildSnapshot(g);
      expect(snap.recentRing.items[0].tokens).toEqual({ prompt_tokens: 5 });
    } finally {
      STATE_PERSISTENCE_CONFIG.persistRecentRing = prev;
    }
  });

  it("caps long string fields", () => {
    const prev = STATE_PERSISTENCE_CONFIG.persistRecentRing;
    STATE_PERSISTENCE_CONFIG.persistRecentRing = true;
    try {
      const g = freshGlobals();
      g._recentRing.items = [{ endpoint: "x".repeat(5000) }];
      const snap = buildSnapshot(g);
      expect(snap.recentRing.items[0].endpoint.length).toBeLessThanOrEqual(201);
    } finally {
      STATE_PERSISTENCE_CONFIG.persistRecentRing = prev;
    }
  });
});

// --- atomic write / read ---------------------------------------------------

describe("writeSnapshot / readSnapshot", () => {
  it("round-trips a snapshot", async () => {
    const g = freshGlobals();
    g._pendingRequests.byModel["m|p"] = 2;
    const snap = buildSnapshot(g);
    await writeSnapshot(snap);

    const loaded = await readSnapshot();
    expect(loaded).not.toBeNull();
    expect(loaded.version).toBe(STATE_VERSION);
    expect(loaded.pendingRequests.byModel["m|p"]).toBe(2);
  });

  it("writes atomically leaving no temp files behind", async () => {
    await writeSnapshot(buildSnapshot(freshGlobals()));
    const entries = await fs.readdir(TMP_DIR);
    expect(entries.filter((f) => f.includes(".tmp"))).toHaveLength(0);
    expect(entries).toContain(STATE_PERSISTENCE_CONFIG.fileName);
  });

  it("returns null when no snapshot exists", async () => {
    expect(await readSnapshot()).toBeNull();
  });

  it("returns null for malformed JSON instead of throwing", async () => {
    await fs.writeFile(path.join(TMP_DIR, STATE_PERSISTENCE_CONFIG.fileName), "{ not json", "utf8");
    expect(await readSnapshot()).toBeNull();
  });

  it("returns null for a version mismatch", async () => {
    await fs.writeFile(
      path.join(TMP_DIR, STATE_PERSISTENCE_CONFIG.fileName),
      JSON.stringify({ version: 999 }),
      "utf8",
    );
    expect(await readSnapshot()).toBeNull();
  });

  it("is idempotent — repeated writes converge on the same content", async () => {
    const snap = buildSnapshot(freshGlobals());
    await writeSnapshot(snap);
    await writeSnapshot(snap);
    const a = await fs.readFile(path.join(TMP_DIR, STATE_PERSISTENCE_CONFIG.fileName), "utf8");
    await writeSnapshot(snap);
    const b = await fs.readFile(path.join(TMP_DIR, STATE_PERSISTENCE_CONFIG.fileName), "utf8");
    expect(a).toBe(b);
  });

  it("does not throw when the target directory is missing", async () => {
    const prevDir = STATE_PERSISTENCE_CONFIG.dir;
    STATE_PERSISTENCE_CONFIG.dir = path.join(TMP_DIR, "nested", "deep");
    try {
      await writeSnapshot(buildSnapshot(freshGlobals()));
      expect(await readSnapshot()).not.toBeNull();
    } finally {
      STATE_PERSISTENCE_CONFIG.dir = prevDir;
    }
  });
});

// --- restore ---------------------------------------------------------------

describe("restoreSnapshot", () => {
  it("restores the dropped-on-restart counters", () => {
    const g = freshGlobals();
    const snap = buildSnapshot({
      ...g,
      _pendingRequests: { byModel: { "m (p)": 4 }, byAccount: {} },
    });
    const restored = restoreSnapshot(snap, g);
    expect(restored).toBe(true);
    // The persisted counts describe requests that were killed by the restart.
    // They are reported separately; the live in-flight gauge stays truthful.
    expect(g._droppedOnRestart.byModel["m (p)"]).toBe(4);
    expect(g._pendingRequests.byModel["m (p)"]).toBeUndefined();
  });

  it("does not inflate the live in-flight gauge", () => {
    const g = freshGlobals();
    const snap = buildSnapshot({
      ...g,
      _pendingRequests: { byModel: { "m (p)": 4 }, byAccount: {} },
    });
    restoreSnapshot(snap, g);
    // Nothing ever decrements a counter for a request that no longer exists,
    // so restoring into the live gauge would make it permanently non-zero.
    expect(g._pendingRequests.byModel).toEqual({});
  });

  it("keeps the live in-flight gauge untouched when there is nothing dropped", () => {
    const g = freshGlobals();
    g._pendingRequests.byModel["m (p)"] = 9;
    const snap = buildSnapshot({
      ...g,
      _pendingRequests: { byModel: {}, byAccount: {} },
    });
    restoreSnapshot(snap, g);
    expect(g._pendingRequests.byModel["m (p)"]).toBe(9);
  });

  it("restores the last error provider when newer than the live value", () => {
    const g = freshGlobals();
    g._lastErrorProvider = { provider: "old", ts: 1000 };
    const snap = buildSnapshot({ ...g, _lastErrorProvider: { provider: "new", ts: 5000 } });
    restoreSnapshot(snap, g);
    expect(g._lastErrorProvider.provider).toBe("new");
  });

  it("keeps the live error provider when it is newer", () => {
    const g = freshGlobals();
    g._lastErrorProvider = { provider: "live", ts: 9000 };
    const snap = buildSnapshot({ ...g, _lastErrorProvider: { provider: "old", ts: 1000 } });
    restoreSnapshot(snap, g);
    expect(g._lastErrorProvider.provider).toBe("live");
  });

  it("is idempotent", () => {
    const g = freshGlobals();
    const snap = buildSnapshot({
      ...g,
      _pendingRequests: { byModel: { "m (p)": 4 }, byAccount: {} },
    });
    restoreSnapshot(snap, g);
    restoreSnapshot(snap, g);
    expect(g._droppedOnRestart.byModel["m (p)"]).toBe(4);
  });

  it("returns false for a null snapshot", () => {
    expect(restoreSnapshot(null, freshGlobals())).toBe(false);
  });
});

// --- persistNow ------------------------------------------------------------

describe("persistNow", () => {
  it("writes a snapshot and reports success", async () => {
    const ok = await persistNow();
    expect(ok).toBe(true);
    expect(await readSnapshot()).not.toBeNull();
  });
});

// --- synchronous writer (shutdown path) ------------------------------------

describe("writeSnapshotSync", () => {
  it("writes the same content as the async writer", async () => {
    const snap = buildSnapshot(freshGlobals());
    await writeSnapshot(snap);
    const asyncContent = await fs.readFile(path.join(TMP_DIR, STATE_PERSISTENCE_CONFIG.fileName), "utf8");

    await fs.rm(path.join(TMP_DIR, STATE_PERSISTENCE_CONFIG.fileName), { force: true });
    writeSnapshotSync(snap);
    const syncContent = await fs.readFile(path.join(TMP_DIR, STATE_PERSISTENCE_CONFIG.fileName), "utf8");

    expect(syncContent).toBe(asyncContent);
  });

  it("leaves no temp files behind", () => {
    writeSnapshotSync(buildSnapshot(freshGlobals()));
    const entries = fsSync.readdirSync(TMP_DIR);
    expect(entries.filter((f) => f.includes(".tmp"))).toHaveLength(0);
  });

  it("creates the target directory when it is missing", () => {
    const prevDir = STATE_PERSISTENCE_CONFIG.dir;
    STATE_PERSISTENCE_CONFIG.dir = path.join(TMP_DIR, "nested", "deep");
    try {
      writeSnapshotSync(buildSnapshot(freshGlobals()));
      expect(fsSync.existsSync(path.join(TMP_DIR, "nested", "deep", STATE_PERSISTENCE_CONFIG.fileName))).toBe(true);
    } finally {
      STATE_PERSISTENCE_CONFIG.dir = prevDir;
    }
  });
});

// --- handler registration --------------------------------------------------

describe("registerStatePersistence", () => {
  it("registers the shutdown handlers exactly once", () => {
    expect(registerStatePersistence()).toBe(true);
    // A second call is a no-op so the handlers are never attached twice.
    expect(registerStatePersistence()).toBe(false);
  });

  it("attaches one SIGTERM and one SIGINT listener", () => {
    const before = {
      sigterm: process.listenerCount("SIGTERM"),
      sigint: process.listenerCount("SIGINT"),
    };
    registerStatePersistence();
    expect(process.listenerCount("SIGTERM")).toBe(before.sigterm + 1);
    expect(process.listenerCount("SIGINT")).toBe(before.sigint + 1);
  });
});
