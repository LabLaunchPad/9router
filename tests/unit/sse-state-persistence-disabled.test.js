/**
 * The persistence kill switch.
 *
 * The PR's rollback table advertises `SSE_STATE_PERSIST_DISABLED` as the way
 * to stop the state file being written. Before this test existed, that
 * variable was read NOWHERE in the codebase: a documented knob that does
 * nothing is worse than no knob, because an operator sets it, sees the
 * behaviour they were trying to stop, and concludes the file is not the
 * problem.
 *
 * The switch is read at import time, so this test has to be its own file:
 * the module registry is per test file, and the variable has to be set
 * BEFORE the module is loaded.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TMP_DIR = path.join(os.tmpdir(), `9router-state-disabled-test-${process.pid}`);
process.env.SSE_STATE_DIR = TMP_DIR;
process.env.SSE_STATE_PERSIST_DISABLED = "true";

const {
  buildSnapshot,
  writeSnapshot,
  writeSnapshotSync,
  readSnapshot,
  persistNow,
  restorePersistedState,
  __resetForTests,
  STATE_PERSISTENCE_CONFIG,
} = await import("../../src/sse/services/state-persistence.js");

let captured = [];
let spies = [];

beforeEach(async () => {
  __resetForTests();
  await fs.rm(TMP_DIR, { recursive: true, force: true });
  await fs.mkdir(TMP_DIR, { recursive: true });
  captured = [];
  const collect = (line) => {
    captured.push(String(line));
  };
  spies = [
    vi.spyOn(console, "warn").mockImplementation(collect),
    vi.spyOn(console, "log").mockImplementation(collect),
    vi.spyOn(console, "error").mockImplementation(collect),
  ];
});

afterEach(async () => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  __resetForTests();
  await fs.rm(TMP_DIR, { recursive: true, force: true });
});

function records() {
  return captured
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

describe("SSE_STATE_PERSIST_DISABLED", () => {
  it("writes no snapshot", async () => {
    const snapshot = buildSnapshot({
      _pendingRequests: { byModel: { "m (p)": 1 }, byAccount: {} },
      _lastErrorProvider: { provider: "", ts: 0 },
      _recentRing: { items: [], initialized: false },
    });

    expect(await writeSnapshot(snapshot)).toBeNull();
    expect(writeSnapshotSync(snapshot)).toBeNull();
    expect(await persistNow()).toBe(false);

    // Nothing on disk, and no temp file left behind.
    const entries = await fs.readdir(TMP_DIR);
    expect(entries).toEqual([]);
    expect(await readSnapshot()).toBeNull();
  });

  it("restores nothing", async () => {
    expect(await restorePersistedState()).toBe(false);
  });

  it("says so, once, in a structured log", async () => {
    await writeSnapshot(buildSnapshot({}));
    await writeSnapshot(buildSnapshot({}));
    await persistNow();

    const notices = records().filter((r) => r.event === "sse_state_persistence_disabled");
    // Once, not once per attempt: a disabled feature that logged on every
    // call would be noise, and one that never logged would be invisible.
    expect(notices).toHaveLength(1);
    expect(notices[0].level).toBe("warn");
    expect(notices[0].env).toBe("SSE_STATE_PERSIST_DISABLED");
  });
});
