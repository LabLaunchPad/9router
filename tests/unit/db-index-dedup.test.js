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

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
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
