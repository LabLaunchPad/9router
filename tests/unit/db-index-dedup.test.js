import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-test-idx-"));
  process.env.DATA_DIR = tempDir;
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(async () => {
  try {
    const driverMod = await import("@/lib/db/driver.js");
    if (typeof driverMod.getAdapterSync === "function") {
      try {
        const adapter = driverMod.getAdapterSync();
        if (adapter && typeof adapter.close === "function") adapter.close();
      } catch {}
    }
    if (typeof driverMod.getAdapter === "function") {
      try {
        const adapter = await driverMod.getAdapter();
        if (adapter && typeof adapter.close === "function") adapter.close();
      } catch {}
    }
  } catch {}
  try {
    if (global._dbAdapter) {
      if (global._dbAdapter.instance && typeof global._dbAdapter.instance.close === "function") {
        try { global._dbAdapter.instance.close(); } catch {}
      }
      global._dbAdapter.instance = null;
      global._dbAdapter.initPromise = null;
    }
  } catch {}
  await new Promise(r => setTimeout(r, 500));
  try {
    if (tempDir) {
      try {
        const dbPath = path.join(tempDir, "db");
        if (fs.existsSync(dbPath)) {
          for (const f of fs.readdirSync(dbPath)) {
            try { fs.unlinkSync(path.join(dbPath, f)); } catch {}
          }
        }
      } catch {}
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); } catch {}
    }
  } catch {}
  await new Promise(r => setTimeout(r, 200));
  if (process.env.DATA_DIR === tempDir) delete process.env.DATA_DIR;
});

describe("DB Schema & Dedup Index Test", () => {
  it("verifies idx_uh_dedup index exists on usageHistory table", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const adapter = await getAdapter();
    const indexes = adapter.all(`PRAGMA index_list('usageHistory')`);
    const dedupIndex = indexes.find((i) => i.name === "idx_uh_dedup");
    expect(dedupIndex).toBeDefined();
  });

  it("persists usage entry successfully without duplicates", async () => {
    const entry = {
      timestamp: new Date().toISOString(),
      provider: "test-provider",
      model: "test-model",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      endpoint: "/v1/chat/completions",
      status: "ok",
    };

    await db.saveRequestUsage(entry);
    await db.saveRequestUsage(entry); // Duplicated insert call with identical timestamp/tokens

    const history = await db.getUsageHistory({ provider: "test-provider" });
    expect(history.length).toBe(1);
  });
});
