// Temp-DATA_DIR lifecycle for DB-backed tests.
//
// Every DB test points DATA_DIR at a fresh mkdtemp() directory, then deletes it
// in teardown. The adapter holds an open handle on <dir>/db/data.sqlite, and on
// Windows an open handle cannot be unlinked: the teardown throws
// "EBUSY: resource busy or locked" *after* all the assertions have passed, which
// fails the file for reasons unrelated to what it tests.
//
// So the order matters: close the adapter, then remove the directory. The retry
// loop in removeTempDataDir is a safety net for the short window in which the OS
// still reports the handle after close() returns.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeAdapter } from "@/lib/db/driver.js";

const RETRIABLE = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

/**
 * Create a temp directory and point DATA_DIR at it.
 * @param {string} prefix mkdtemp prefix, e.g. "9router-model-routing-"
 * @returns {string} the directory
 */
export function makeTempDataDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DATA_DIR = dir;
  return dir;
}

/**
 * Close the adapter so its SQLite handle is released.
 * Safe to call when no adapter was ever initialised.
 */
export async function closeTempDb() {
  await closeAdapter();
  try { delete globalThis._dbAdapter; } catch { /* not configurable */ }
}

/**
 * Remove a temp DATA_DIR, retrying while the OS still reports it as busy.
 * @param {string} dir
 * @param {{ attempts?: number, delayMs?: number }} [options]
 */
export async function removeTempDataDir(dir, { attempts = 20, delayMs = 25 } = {}) {
  if (!dir) return;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const last = attempt === attempts - 1;
      if (last || !RETRIABLE.has(err?.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
}

/**
 * Close the adapter, then remove the directory. The one call teardown needs.
 * @param {string} dir
 */
export async function cleanupTempDataDir(dir) {
  await closeTempDb();
  await removeTempDataDir(dir);
}
