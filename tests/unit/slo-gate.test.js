import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Import the pure helpers from the CI script. The script is plain ESM with no
// runtime dependencies, so it can be imported directly.
import {
  parseMetric,
  sumMetric,
  parseBudgetConsumed,
  decide,
  evaluate,
} from "../../scripts/ci/validate-slo.mjs";

const SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "ci",
  "validate-slo.mjs",
);

/**
 * Run the gate script as a real child process and capture its exit code.
 * This is the only way to assert the process-level contract (exit codes and
 * the fail-closed behaviour) that CI actually depends on.
 */
function runGate(env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT_PATH], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// --- Fixtures ---------------------------------------------------------------

const BASE_CONFIG = {
  warningThreshold: 50,
  blockedThreshold: 75,
  exhaustedThreshold: 95,
  windowSeconds: 2592000,
  failClosed: true,
  // The error budget allowance, matching the app's own target
  // (computeErrorBudgetConsumed in src/sse/services/metrics.js).
  targetErrorRate: 0.0005,
  requireFullWindow: true,
};

/** Build a Prometheus exposition body with the given gauge value. */
function metricsWithBudgetConsumed(fraction) {
  return [
    "# HELP sse_error_budget_consumed Error budget consumed (0-1)",
    "# TYPE sse_error_budget_consumed gauge",
    `sse_error_budget_consumed ${fraction}`,
    "# HELP sse_requests_total Total SSE requests",
    "# TYPE sse_requests_total counter",
    'sse_requests_total{status="2xx"} 1000',
    "",
  ].join("\n");
}

function metricsWithCounters(total, errors) {
  return [
    "# HELP sse_requests_total Total SSE requests",
    "# TYPE sse_requests_total counter",
    `sse_requests_total ${total}`,
    "# HELP sse_error_responses_total Error responses",
    "# TYPE sse_error_responses_total counter",
    `sse_error_responses_total ${errors}`,
    "",
  ].join("\n");
}

/**
 * The exposition shape the app actually produces: one series per label
 * combination, with the 2xx series first and the 5xx series last.
 */
function metricsWithLabelledSeries(series) {
  return [
    "# TYPE sse_requests_total counter",
    ...series.map(([labels, value]) => `sse_requests_total${labels} ${value}`),
    "",
  ].join("\n");
}

// --- parseMetric -----------------------------------------------------------

describe("parseMetric", () => {
  it("returns null when the metric is absent", () => {
    expect(parseMetric("some_other_metric 5", "sse_requests_total")).toBeNull();
  });

  it("returns null for an empty body", () => {
    expect(parseMetric("", "sse_requests_total")).toBeNull();
  });

  it("parses an unlabelled metric", () => {
    expect(parseMetric("sse_requests_total 42", "sse_requests_total")).toBe(42);
  });

  it("parses a labelled metric", () => {
    const body = 'sse_requests_total{status="2xx",provider="openai"} 17';
    expect(parseMetric(body, "sse_requests_total")).toBe(17);
  });

  it("takes the last occurrence when a metric has multiple series", () => {
    // parseMetric is the single-series reader: it is used for gauges, which
    // the app exports without labels. Counters must be read with sumMetric.
    const body = [
      'sse_requests_total{status="2xx"} 10',
      'sse_requests_total{status="5xx"} 3',
    ].join("\n");
    expect(parseMetric(body, "sse_requests_total")).toBe(3);
  });

  it("ignores comment lines", () => {
    const body = "# TYPE sse_requests_total counter\nsse_requests_total 9";
    expect(parseMetric(body, "sse_requests_total")).toBe(9);
  });

  it("does not match a metric whose name merely starts with the target", () => {
    expect(parseMetric("sse_requests_total_bytes 5", "sse_requests_total")).toBeNull();
  });

  it("ignores non-numeric values", () => {
    expect(parseMetric("sse_requests_total NaN", "sse_requests_total")).toBeNull();
  });
});

// --- sumMetric --------------------------------------------------------------

describe("sumMetric", () => {
  it("returns null when the metric is absent", () => {
    expect(sumMetric("other 5", "sse_requests_total")).toBeNull();
  });

  it("sums every series of a multi-series counter", () => {
    // This is the shape the app really emits: one series per label set.
    const body = [
      'sse_requests_total{status="2xx",endpoint="/v1/chat/completions"} 100000',
      'sse_requests_total{status="2xx",endpoint="/v1/messages"} 50000',
      'sse_requests_total{status="5xx",endpoint="/v1/chat/completions"} 1',
    ].join("\n");
    expect(sumMetric(body, "sse_requests_total")).toBe(150001);
  });

  it("sums an unlabelled counter", () => {
    expect(sumMetric("sse_requests_total 42", "sse_requests_total")).toBe(42);
  });

  it("ignores comment lines", () => {
    const body = "# TYPE sse_requests_total counter\nsse_requests_total 9";
    expect(sumMetric(body, "sse_requests_total")).toBe(9);
  });

  it("does not match a metric whose name merely starts with the target", () => {
    expect(sumMetric("sse_requests_total_bytes 5", "sse_requests_total")).toBeNull();
  });
});

// --- parseBudgetConsumed ---------------------------------------------------

describe("parseBudgetConsumed", () => {
  it("prefers the explicit gauge and converts 0..1 to a percentage", () => {
    const result = parseBudgetConsumed(metricsWithBudgetConsumed(0.42));
    expect(result.consumedPercent).toBe(42);
    expect(result.source).toBe("gauge");
  });

  it("handles a fully consumed budget", () => {
    const result = parseBudgetConsumed(metricsWithBudgetConsumed(1));
    expect(result.consumedPercent).toBe(100);
  });

  it("handles a zero-consumed budget", () => {
    const result = parseBudgetConsumed(metricsWithBudgetConsumed(0));
    expect(result.consumedPercent).toBe(0);
  });

  it("falls back to counters when no gauge is present", () => {
    // 25 errors out of 100 000 requests = a 0.025% error rate. Against a
    // 0.05% error budget (99.95% availability) that is half the budget, so
    // the consumed percentage must be 50 — not the raw error rate (0.025).
    const result = parseBudgetConsumed(metricsWithCounters(100000, 25), BASE_CONFIG);
    expect(result.source).toBe("counters");
    expect(result.consumedPercent).toBe(50);
  });

  it("caps the consumed percentage at 100 when the budget is overrun", () => {
    // 25 errors out of 1000 requests is 2.5% — fifty times the budget.
    const result = parseBudgetConsumed(metricsWithCounters(1000, 25), BASE_CONFIG);
    expect(result.consumedPercent).toBe(100);
  });

  it("agrees with the app's own budget-consumption formula", () => {
    // The registry computes: min(1, errorRate / targetErrorRate).
    const total = 150001;
    const errors = 1;
    const expected = Math.min(1, (errors / total) / BASE_CONFIG.targetErrorRate) * 100;
    const result = parseBudgetConsumed(
      [
        'sse_requests_total{status="2xx",endpoint="/v1/chat/completions"} 100000',
        'sse_requests_total{status="2xx",endpoint="/v1/messages"} 50000',
        'sse_requests_total{status="5xx",endpoint="/v1/chat/completions"} 1',
        'sse_error_responses_total{endpoint="/v1/chat/completions"} 1',
      ].join("\n"),
      BASE_CONFIG,
    );
    expect(result.source).toBe("counters");
    expect(result.consumedPercent).toBeCloseTo(expected, 2);
  });

  it("sums the labelled request series rather than reading the last one", () => {
    // A healthy service with a single error must NOT read as "100% of the
    // budget consumed" — which is what dividing the last 5xx series by the
    // last error series produced.
    const result = parseBudgetConsumed(
      [
        'sse_requests_total{status="2xx",endpoint="/v1/chat/completions"} 100000',
        'sse_requests_total{status="2xx",endpoint="/v1/messages"} 50000',
        'sse_requests_total{status="5xx",endpoint="/v1/chat/completions"} 1',
        'sse_error_responses_total{endpoint="/v1/chat/completions"} 1',
      ].join("\n"),
      BASE_CONFIG,
    );
    expect(result.consumedPercent).toBeLessThan(5);
    expect(result.consumedPercent).toBeCloseTo(1.33, 1);
  });

  it("caps the consumed percentage at 100", () => {
    const result = parseBudgetConsumed(metricsWithCounters(100, 90), BASE_CONFIG);
    expect(result.consumedPercent).toBe(100);
  });

  it("returns null when neither signal is present", () => {
    expect(parseBudgetConsumed("# TYPE other gauge\nother 1", BASE_CONFIG)).toBeNull();
  });

  it("returns null for an empty body", () => {
    expect(parseBudgetConsumed("", BASE_CONFIG)).toBeNull();
  });

  it("returns null when the request counter is zero and no gauge exists", () => {
    expect(parseBudgetConsumed(metricsWithCounters(0, 0), BASE_CONFIG)).toBeNull();
  });
});

// --- decide (policy) --------------------------------------------------------

describe("decide", () => {
  it("allows deployment when the budget is healthy", () => {
    const d = decide(10, BASE_CONFIG);
    expect(d.decision).toBe("allow");
    expect(d.exitCode).toBe(0);
  });

  it("allows deployment just below the warning threshold", () => {
    const d = decide(49.99, BASE_CONFIG);
    expect(d.decision).toBe("allow");
    expect(d.exitCode).toBe(0);
  });

  it("requires manual approval at the warning threshold", () => {
    const d = decide(50, BASE_CONFIG);
    expect(d.decision).toBe("warn");
    expect(d.exitCode).toBe(2);
  });

  it("requires manual approval between the warning and blocked thresholds", () => {
    const d = decide(60, BASE_CONFIG);
    expect(d.decision).toBe("warn");
    expect(d.exitCode).toBe(2);
  });

  it("blocks deployment at the blocked threshold", () => {
    const d = decide(75, BASE_CONFIG);
    expect(d.decision).toBe("block");
    expect(d.exitCode).toBe(1);
  });

  it("blocks deployment above the blocked threshold", () => {
    const d = decide(90, BASE_CONFIG);
    expect(d.decision).toBe("block");
    expect(d.exitCode).toBe(1);
  });

  it("blocks deployment when the budget is exhausted", () => {
    const d = decide(95, BASE_CONFIG);
    expect(d.decision).toBe("block");
    expect(d.exitCode).toBe(1);
  });

  it("always blocks when the budget is fully exhausted", () => {
    const d = decide(100, BASE_CONFIG);
    expect(d.decision).toBe("block");
    expect(d.exitCode).toBe(1);
    expect(d.reason).toMatch(/exhausted/i);
  });

  it("respects custom thresholds", () => {
    const strict = { ...BASE_CONFIG, warningThreshold: 10, blockedThreshold: 20, exhaustedThreshold: 30 };
    expect(decide(15, strict).decision).toBe("warn");
    expect(decide(25, strict).decision).toBe("block");
  });

  it("includes the consumption and threshold in the reason", () => {
    const d = decide(80, BASE_CONFIG);
    expect(d.reason).toContain("80");
    expect(d.reason).toContain("75");
  });
});

// --- HTTP failure + override behaviour -------------------------------------

describe("SLO gate evaluate()", () => {
  const cfg = { ...BASE_CONFIG, overrideApproved: false, overrideReason: "unspecified" };

  it("allows a healthy budget", () => {
    const r = evaluate({ metricsText: metricsWithBudgetConsumed(0.1), cfg });
    expect(r.decision).toBe("allow");
    expect(r.exitCode).toBe(0);
    expect(r.consumedPercent).toBe(10);
  });

  it("warns at the warning threshold", () => {
    const r = evaluate({ metricsText: metricsWithBudgetConsumed(0.5), cfg });
    expect(r.decision).toBe("warn");
    expect(r.exitCode).toBe(2);
  });

  it("blocks at the blocked threshold", () => {
    const r = evaluate({ metricsText: metricsWithBudgetConsumed(0.75), cfg });
    expect(r.decision).toBe("block");
    expect(r.exitCode).toBe(1);
  });

  it("blocks when the budget is exhausted", () => {
    const r = evaluate({ metricsText: metricsWithBudgetConsumed(0.99), cfg });
    expect(r.decision).toBe("block");
    expect(r.exitCode).toBe(1);
    expect(r.reason).toMatch(/exhausted/i);
  });

  it("blocks when the metric is missing", () => {
    const r = evaluate({ metricsText: "# TYPE other gauge\nother 1\n", cfg });
    expect(r.decision).toBe("block");
    expect(r.exitCode).toBe(1);
    expect(r.reason).toMatch(/malformed/i);
  });

  it("blocks when the body is not valid Prometheus text", () => {
    const r = evaluate({ metricsText: "<html><body>not metrics</body></html>", cfg });
    expect(r.decision).toBe("block");
    expect(r.exitCode).toBe(1);
  });

  it("blocks when the endpoint returns a non-2xx response", () => {
    const r = evaluate({ fetchError: "HTTP 503", cfg });
    expect(r.decision).toBe("block");
    expect(r.exitCode).toBe(1);
    expect(r.reason).toMatch(/unavailable/i);
  });

  it("blocks when the request times out", () => {
    const r = evaluate({ fetchError: "request timed out", cfg });
    expect(r.decision).toBe("block");
    expect(r.exitCode).toBe(1);
  });

  it("fails open on unavailable data only when fail-closed is disabled", () => {
    const r = evaluate({ fetchError: "ECONNREFUSED", cfg: { ...cfg, failClosed: false } });
    expect(r.exitCode).toBe(0);
  });

  it("fails open on malformed data only when fail-closed is disabled", () => {
    const r = evaluate({ metricsText: "garbage", cfg: { ...cfg, failClosed: false } });
    expect(r.exitCode).toBe(0);
  });

  it("allows the deploy when the override is approved", () => {
    const r = evaluate({
      metricsText: metricsWithBudgetConsumed(0.99),
      cfg: { ...cfg, overrideApproved: true, overrideReason: "hotfix INC-1" },
    });
    expect(r.decision).toBe("allow");
    expect(r.exitCode).toBe(0);
    expect(r.override).toBe(true);
  });

  it("blocks when the sample is younger than the SLO window", () => {
    // The counters live in the service process, so a sample that does not
    // span the window cannot represent the budget over that window. Reading
    // it as if it could would allow exactly the deploys the gate exists to
    // catch — a crash-looping service has just reset its counters.
    const metrics = [
      "sse_error_budget_consumed 0",
      "sse_metrics_sample_age_seconds 120",
      "",
    ].join("\n");
    const r = evaluate({ metricsText: metrics, cfg });
    expect(r.decision).toBe("block");
    expect(r.exitCode).toBe(1);
    expect(r.reason).toMatch(/window/i);
  });

  it("does not block on a short sample when the full-window requirement is disabled", () => {
    const metrics = [
      "sse_error_budget_consumed 0",
      "sse_metrics_sample_age_seconds 120",
      "",
    ].join("\n");
    const r = evaluate({ metricsText: metrics, cfg: { ...cfg, requireFullWindow: false } });
    expect(r.decision).toBe("allow");
  });

  it("does not block when the sample spans the window", () => {
    const metrics = [
      "sse_error_budget_consumed 0.1",
      "sse_metrics_sample_age_seconds 2592000",
      "",
    ].join("\n");
    const r = evaluate({ metricsText: metrics, cfg });
    expect(r.decision).toBe("allow");
  });

  it("the override also wins over unavailable SLO data", () => {
    const r = evaluate({
      fetchError: "HTTP 500",
      cfg: { ...cfg, overrideApproved: true, overrideReason: "hotfix INC-1" },
    });
    expect(r.decision).toBe("allow");
    expect(r.exitCode).toBe(0);
  });

  it("reports the source of the signal", () => {
    expect(evaluate({ metricsText: metricsWithBudgetConsumed(0.1), cfg }).source).toBe("gauge");
    expect(evaluate({ metricsText: metricsWithCounters(1000, 10), cfg }).source).toBe("counters");
  });
});

// --- process-level contract (what CI actually depends on) ------------------

describe("SLO gate process exit codes", () => {
  it("exits 1 when SLO_METRICS_ENDPOINT is not configured", async () => {
    // No localhost fallback: a CI-runner endpoint would measure the runner,
    // not the service, so an unset endpoint is a hard fail.
    const res = await runGate({});
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/SLO_METRICS_ENDPOINT is not set/i);
  });

  it("exits 1 when the metrics endpoint is unreachable", async () => {
    const res = await runGate({
      // Port 9 (discard) is closed on a default install.
      SLO_METRICS_ENDPOINT: "http://127.0.0.1:9/metrics",
      SLO_FETCH_TIMEOUT_MS: "1500",
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/unavailable|failed to fetch/i);
  });

  it("exits 0 when the override is approved, even with no endpoint", async () => {
    const res = await runGate({
      SLO_GATE_OVERRIDE_APPROVED: "true",
      SLO_GATE_OVERRIDE_REASON: "hotfix INC-4711",
    });
    expect(res.code).toBe(0);
    expect(res.stderr).toMatch(/override/i);
  });

  it("logs the actor, SHA and reason when the override is used", async () => {
    const res = await runGate({
      SLO_GATE_OVERRIDE_APPROVED: "true",
      SLO_GATE_OVERRIDE_REASON: "hotfix INC-4711",
      GITHUB_ACTOR: "release-bot",
      GITHUB_SHA: "87a74e1b",
    });
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("release-bot");
    expect(res.stderr).toContain("87a74e1b");
    expect(res.stderr).toContain("hotfix INC-4711");
  });
});
