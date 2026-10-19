// src/sse/services/state-persistence.js
//
// Graceful-restart persistence for a small, non-sensitive slice of in-memory
// SSE operational state.
//
// WHY THIS EXISTS
// On a rolling restart the process loses:
//   - in-flight request counters (usageRepo's global._pendingRequests)
//   - the "last error provider" marker (global._lastErrorProvider)
//   - the recent-requests ring buffer (global._recentRing)
//
// The first two cause transient under-counting and lost error context; the
// ring buffer is already rehydrated from SQLite by usageRepo, so persisting
// it is optional and is disabled by default (see CONFIG.persistRecentRing).
//
// WHAT IS NEVER PERSISTED
//   - API keys, tokens, cookies, secrets, credentials
//   - Prompt or completion text, request/response bodies
//   - Raw HTTP headers
//   - PII
//   - Sockets, streams, timers, connection objects
//
// The sanitiser below is an allow-list, not a deny-list: only fields that are
// explicitly permitted are written. Anything unexpected is dropped.
//
// CRASH SAFETY
// Writes go to a temp file, are fsync'd, then atomically renamed over the
// target. A crash mid-write therefore leaves either the previous complete
// file or the new complete file — never a truncated one.
//
// REQUEST PATH SAFETY
// Nothing in this module runs on the request path. The only work performed
// during normal operation is an async, debounced snapshot write.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { structuredInfo, structuredWarn, structuredError } from "../utils/logger.js";

const CONFIG = {
  // Directory for the state file. Defaults to the app data dir.
  dir: process.env.SSE_STATE_DIR || DATA_DIR,
  fileName: "sse-state.json",

  // Debounce window for periodic snapshots (ms). Snapshots are cheap and
  // idempotent; this simply avoids writing on every single state change.
  snapshotDebounceMs: Number(process.env.SSE_STATE_SNAPSHOT_INTERVAL_MS) || 5000,

  // The ring buffer contains request records. usageRepo already rehydrates it
  // from SQLite, so persisting it is redundant and increases the surface of
  // data written to disk. Off by default.
  persistRecentRing: process.env.SSE_STATE_PERSIST_RING === "true",

  // Max ring entries to persist when enabled.
  maxRingEntries: 50,
};

const STATE_VERSION = 1;

// Fields permitted on a ring entry. Everything else is dropped.
const RING_ENTRY_ALLOWED_FIELDS = [
  "timestamp",
  "provider",
  "model",
  "connectionId",
  "endpoint",
  "cost",
  "status",
  "tokens",
];

// ---------------------------------------------------------------------------
// Sanitisation (allow-list)
// ---------------------------------------------------------------------------

/**
 * Strip a ring-buffer entry down to permitted, non-sensitive fields.
 * @param {object} entry
 * @returns {object|null}
 */
function sanitizeRingEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const safe = {};
  for (const field of RING_ENTRY_ALLOWED_FIELDS) {
    if (!(field in entry)) continue;
    const value = entry[field];
    if (value === null || value === undefined) continue;
    if (typeof value === "object") {
      // `tokens` is a numeric bag; keep only numeric leaves.
      if (field === "tokens" && value && typeof value === "object") {
        const numeric = {};
        for (const [k, v] of Object.entries(value)) {
          if (typeof v === "number" && Number.isFinite(v)) numeric[k] = v;
        }
        safe.tokens = numeric;
      }
      continue;
    }
    if (typeof value === "string") {
      // Cap length to bound the file and avoid embedding large payloads.
      safe[field] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      safe[field] = value;
    }
  }

  return Object.keys(safe).length > 0 ? safe : null;
}

/**
 * Sanitise the pending-request counters.
 *
 * Structure: { byModel: { "<model> (<provider>)": number },
 *              byAccount: { "<connectionId>": { "<model> (<provider>)": number } } }
 *
 * The key shape is the one the producer builds in
 * src/lib/db/repos/usageRepo.js: `${model} (${provider})` — a parenthesised
 * provider, not a `|`-separated one.
 *
 * Only counts are kept — no identifiers beyond model/connection keys, which
 * are already operational identifiers (not user data).
 */
function sanitizePending(pending) {
  if (!pending || typeof pending !== "object") return { byModel: {}, byAccount: {} };

  const byModel = {};
  for (const [modelKey, count] of Object.entries(pending.byModel || {})) {
    const n = Number(count);
    if (Number.isFinite(n) && n > 0) byModel[String(modelKey).slice(0, 200)] = n;
  }

  const byAccount = {};
  for (const [connectionId, models] of Object.entries(pending.byAccount || {})) {
    if (!models || typeof models !== "object") continue;
    const safeModels = {};
    for (const [modelKey, count] of Object.entries(models)) {
      const n = Number(count);
      if (Number.isFinite(n) && n > 0) safeModels[String(modelKey).slice(0, 200)] = n;
    }
    if (Object.keys(safeModels).length > 0) {
      byAccount[String(connectionId).slice(0, 100)] = safeModels;
    }
  }

  return { byModel, byAccount };
}

// ---------------------------------------------------------------------------
// Snapshot construction
// ---------------------------------------------------------------------------

/**
 * Build the sanitised snapshot from current global state.
 * Exported for unit testing.
 */
export function buildSnapshot(globals = global) {
  const snapshot = {
    version: STATE_VERSION,
    persistedAt: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    pendingRequests: sanitizePending(globals._pendingRequests),
    lastErrorProvider: null,
    recentRing: null,
  };

  const err = globals._lastErrorProvider;
  if (err && typeof err === "object" && typeof err.provider === "string" && err.provider) {
    snapshot.lastErrorProvider = {
      provider: err.provider.slice(0, 100),
      ts: Number(err.ts) || 0,
    };
  }

  if (CONFIG.persistRecentRing) {
    const ring = globals._recentRing;
    const items = Array.isArray(ring?.items) ? ring.items : [];
    const safeItems = items
      .slice(-CONFIG.maxRingEntries)
      .map(sanitizeRingEntry)
      .filter(Boolean);
    snapshot.recentRing = { items: safeItems };
  }

  return snapshot;
}

// ---------------------------------------------------------------------------
// Atomic IO
// ---------------------------------------------------------------------------

function stateFilePath() {
  return path.join(CONFIG.dir, CONFIG.fileName);
}

// Every write gets its own temp file. Two writers must never share a path:
// the periodic async writer and the synchronous shutdown writer can overlap,
// and a shared path means the shutdown snapshot is truncated by the other
// writer (or vice versa) — the async rename then fails with ENOENT and the
// file on disk is the wrong snapshot.
let tempCounter = 0;
function tempFilePath(tag = "w") {
  tempCounter += 1;
  return `${stateFilePath()}.${process.pid}.${tag}.${tempCounter}.tmp`;
}

/**
 * Write a snapshot atomically: temp file -> fsync -> rename.
 * @param {object} snapshot
 */
export async function writeSnapshot(snapshot) {
  const target = stateFilePath();
  const tmp = tempFilePath();

  await fs.mkdir(CONFIG.dir, { recursive: true });

  const payload = JSON.stringify(snapshot, null, 2);
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(payload, "utf8");
    // fsync the file contents before the rename so the rename cannot expose
    // a file whose data is still only in the page cache.
    try {
      await handle.sync();
    } catch {
      // Some filesystems (and some container overlays) do not support fsync.
      // The rename is still atomic, so this is a durability nicety, not a
      // correctness requirement.
    }
  } catch (err) {
    // Never leave a stray temp file behind: a crashed or interrupted write
    // would otherwise leak one file per restart into the state directory.
    await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  } finally {
    await handle.close().catch(() => {});
  }

  try {
    await fs.rename(tmp, target);
  } catch (err) {
    // A failed rename leaks the temp file just like a failed write did.
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return target;
}

/**
 * Synchronous variant of writeSnapshot, used on the shutdown path.
 *
 * Shutdown handlers elsewhere in the app (see initializeApp.js) call
 * process.exit() synchronously, which would kill an in-flight async write
 * mid-file. A synchronous write is the only way to guarantee the snapshot
 * lands on disk before the process dies. This is NOT on the request path —
 * it only runs once, during shutdown.
 *
 * @param {object} snapshot
 */
export function writeSnapshotSync(snapshot) {
  const target = stateFilePath();
  const tmp = tempFilePath("sync");

  fsSync.mkdirSync(CONFIG.dir, { recursive: true });

  const payload = JSON.stringify(snapshot, null, 2);
  let fd;
  try {
    fd = fsSync.openSync(tmp, "w");
  } catch (err) {
    throw err;
  }
  try {
    fsSync.writeFileSync(fd, payload, "utf8");
    try {
      fsSync.fsyncSync(fd);
    } catch {
      // Not every filesystem supports fsync; the rename below is still atomic.
    }
  } catch (err) {
    try { fsSync.closeSync(fd); } catch { /* ignore */ }
    try { fsSync.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  } finally {
    try { fsSync.closeSync(fd); } catch { /* ignore */ }
  }

  try {
    fsSync.renameSync(tmp, target);
  } catch (err) {
    // A failed rename leaks the temp file just like a failed write did.
    try { fsSync.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
  return target;
}

/**
 * Read and validate a persisted snapshot.
 * Returns null when absent or invalid (never throws).
 */
export async function readSnapshot() {
  const target = stateFilePath();
  let raw;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    structuredWarn("sse_state_read_failed", { reason: err?.message });
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== STATE_VERSION) {
      structuredWarn("sse_state_version_mismatch", {
        found: parsed.version,
        expected: STATE_VERSION,
      });
      return null;
    }
    return parsed;
  } catch (err) {
    structuredWarn("sse_state_parse_failed", { reason: err?.message });
    return null;
  }
}

/**
 * Restore a persisted snapshot into the live globals.
 * Idempotent: restoring twice yields the same result.
 *
 * The persisted pending counters describe requests that were in flight when
 * the previous process stopped — they were killed by the restart and will
 * never complete. Restoring them into the live in-flight gauge would make
 * `pendingRequests` permanently non-zero (nothing ever decrements a counter
 * for a request that no longer exists), so they are restored as a separate
 * "dropped on restart" figure instead. The live gauge stays truthful.
 *
 * @returns {boolean} true when state was restored
 */
export function restoreSnapshot(snapshot, globals = global) {
  if (!snapshot || typeof snapshot !== "object") return false;

  try {
    const dropped = snapshot.pendingRequests;
    if (dropped && (Object.keys(dropped.byModel || {}).length || Object.keys(dropped.byAccount || {}).length)) {
      globals._droppedOnRestart = {
        at: snapshot.persistedAt || null,
        byModel: { ...(dropped.byModel || {}) },
        byAccount: { ...(dropped.byAccount || {}) },
      };
    }

    if (snapshot.lastErrorProvider?.provider) {
      if (!globals._lastErrorProvider) {
        globals._lastErrorProvider = { provider: "", ts: 0 };
      }
      // Only restore if the current marker is stale, otherwise the live value wins.
      const currentTs = Number(globals._lastErrorProvider.ts) || 0;
      if (snapshot.lastErrorProvider.ts > currentTs) {
        globals._lastErrorProvider.provider = snapshot.lastErrorProvider.provider;
        globals._lastErrorProvider.ts = snapshot.lastErrorProvider.ts;
      }
    }

    if (snapshot.recentRing?.items?.length) {
      if (!globals._recentRing) {
        globals._recentRing = { items: [], initialized: false };
      }
      if (!globals._recentRing.initialized) {
        // Deliberately NOT setting `initialized` here: usageRepo's
        // ensureRingInitialized() uses that flag to decide whether to
        // rehydrate the ring from SQLite. Claiming it here would silently
        // discard the persisted request history.
        globals._recentRing.items = [
          ...snapshot.recentRing.items,
          ...(globals._recentRing.items || []),
        ].slice(-CONFIG.maxRingEntries);
      }
    }

    structuredInfo("sse_state_restored", {
      droppedModels: Object.keys(dropped?.byModel || {}).length,
      hasErrorProvider: Boolean(snapshot.lastErrorProvider?.provider),
      ringRestored: Boolean(snapshot.recentRing?.items?.length),
    });
    return true;
  } catch (err) {
    structuredError("sse_state_restore_failed", { reason: err?.message });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle wiring
// ---------------------------------------------------------------------------

let handlersRegistered = false;
let snapshotTimer = null;
let snapshotInterval = null;
let pendingSnapshot = false;
// References to what we attached, so __resetForTests() can detach it.
const attachedHandlers = {};

/**
 * Persist a snapshot now (async, non-blocking).
 */
export async function persistNow() {
  try {
    const snapshot = buildSnapshot();
    const target = await writeSnapshot(snapshot);
    structuredInfo("sse_state_persisted", {
      path: target,
      pendingModels: Object.keys(snapshot.pendingRequests.byModel).length,
      ringItems: snapshot.recentRing?.items?.length || 0,
    });
    return true;
  } catch (err) {
    structuredError("sse_state_persist_failed", { reason: err?.message });
    return false;
  }
}

/**
 * Schedule a debounced snapshot. Safe to call frequently.
 */
export function scheduleSnapshot() {
  if (snapshotTimer) return;
  pendingSnapshot = true;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    pendingSnapshot = false;
    void persistNow();
  }, CONFIG.snapshotDebounceMs);
  snapshotTimer.unref?.();
}

/**
 * Restore any persisted state. Call once during startup.
 */
export async function restorePersistedState() {
  const snapshot = await readSnapshot();
  if (!snapshot) {
    structuredInfo("sse_state_no_snapshot", {});
    return false;
  }
  return restoreSnapshot(snapshot);
}

/**
 * Register shutdown handlers. Safe to call multiple times — the handlers are
 * only attached on the first call.
 *
 * The write is synchronous on purpose: other shutdown handlers in the app
 * (see src/shared/services/initializeApp.js) call process.exit() as soon as
 * they run, so an async write could be killed before it lands. The sync write
 * runs once, during shutdown — never on the request path.
 *
 * The handler does not exit the process itself unless it is the only signal
 * listener; otherwise the app's own shutdown handler owns the exit and this
 * one just makes sure the snapshot is on disk first.
 *
 * `process.on` is used rather than `process.once` on purpose. With
 * `process.once`, Node removes the listener from the array *before* the
 * handler body runs, so `process.listeners(signal).length` inside the handler
 * counts only the OTHER listeners — which made the "am I the only listener?"
 * check below fire even when the app had its own SIGTERM handler, and
 * `process.exit(0)` truncated the app's cleanup (killing the cloudflared
 * tunnel and the MCP bridges). The `handlersRegistered` guard is what
 * prevents double registration; `process.once` was never needed for that.
 *
 * @param {object} [options]
 * @param {boolean} [options.exitIfSoleListener=true] exit when no other handler owns the shutdown
 */
export function registerStatePersistence(options = {}) {
  if (handlersRegistered) return false;
  handlersRegistered = true;

  const exitIfSoleListener = options.exitIfSoleListener !== false;

  let persistedForShutdown = false;

  const onSignal = (signal) => {
    if (persistedForShutdown) return;
    persistedForShutdown = true;

    structuredInfo("sse_state_shutdown_signal", { signal, pendingDebounce: pendingSnapshot });
    pendingSnapshot = false;
    try {
      const snapshot = buildSnapshot();
      const target = writeSnapshotSync(snapshot);
      structuredInfo("sse_state_persisted_on_shutdown", {
        path: target,
        pendingModels: Object.keys(snapshot.pendingRequests.byModel).length,
      });
    } catch (err) {
      structuredError("sse_state_persist_failed", { reason: err?.message });
    }

    // If nothing else handles the signal, the process would ignore it and
    // hang instead of terminating the way it would have without us. With
    // process.on, this handler is still in the listener list, so "length <= 1"
    // means "this handler and nothing else".
    if (exitIfSoleListener && process.listeners(signal).length <= 1) {
      process.exit(0);
    }
  };

  const onSigterm = () => onSignal("SIGTERM");
  const onSigint = () => onSignal("SIGINT");
  attachedHandlers.SIGTERM = onSigterm;
  attachedHandlers.SIGINT = onSigint;
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  // Periodic background snapshot so an ungraceful crash loses at most one
  // debounce window of state.
  snapshotInterval = setInterval(() => scheduleSnapshot(), CONFIG.snapshotDebounceMs);
  snapshotInterval.unref?.();

  structuredInfo("sse_state_persistence_registered", {
    dir: CONFIG.dir,
    intervalMs: CONFIG.snapshotDebounceMs,
    persistRecentRing: CONFIG.persistRecentRing,
  });

  return true;
}

/**
 * Test helper: reset module-level scheduling state.
 *
 * Detaches everything this module registered. Clearing the `handlersRegistered`
 * flag without removing the listeners would let a second registration attach
 * another pair, so the handlers would accumulate across tests.
 */
export function __resetForTests() {
  handlersRegistered = false;
  pendingSnapshot = false;
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  if (snapshotInterval) {
    clearInterval(snapshotInterval);
    snapshotInterval = null;
  }
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const fn = attachedHandlers[signal];
    if (fn) {
      process.removeListener(signal, fn);
      delete attachedHandlers[signal];
    }
  }
}

export { CONFIG as STATE_PERSISTENCE_CONFIG, STATE_VERSION };
