import { describe, it, expect, beforeAll } from "vitest";
import { saveRequestUsage, getUsageStats, getUsageHistory } from "../../src/lib/db/repos/usageRepo.js";
import { getAdapter } from "../../src/lib/db/driver.js";

describe("Database Adapter & Repository Benchmark", () => {
  let db;

  beforeAll(async () => {
    db = await getAdapter();
  });

  it("verifies WAL mode and Pragmas are set on active SQLite adapter", async () => {
    const journalMode = db.get("PRAGMA journal_mode");
    expect(journalMode?.journal_mode?.toLowerCase()).toBe("wal");
  });

  it("measures serial insertion throughput for usage records", async () => {
    const start = Date.now();
    const records = 50;
    for (let i = 0; i < records; i++) {
      await saveRequestUsage({
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
        provider: "openai",
        model: "gpt-4o",
        connectionId: "conn-bench-db",
        apiKey: "sk-bench-key",
        endpoint: "/v1/chat/completions",
        tokens: { prompt_tokens: 100, completion_tokens: 50 },
        status: "ok"
      });
    }
    const duration = Date.now() - start;
    expect(duration).toBeLessThan(3000); // 50 writes <3000ms
  });

  it("measures query latency for getUsageStats (24h window)", async () => {
    const start = Date.now();
    const stats = await getUsageStats("24h");
    const duration = Date.now() - start;

    expect(stats).toBeDefined();
    expect(stats.byProvider.openai).toBeDefined();
    expect(duration).toBeLessThan(150); // Query <150ms
  });

  it("measures query latency for getUsageHistory", async () => {
    const start = Date.now();
    const history = await getUsageHistory({ provider: "openai" });
    const duration = Date.now() - start;

    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThan(0);
    expect(duration).toBeLessThan(100);
  });
});
