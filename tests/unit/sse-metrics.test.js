import { describe, expect, it, beforeEach } from "vitest";

import {
  incrementCounter,
  setGauge,
  addGauge,
  observeLatency,
  recordRequest,
  renderPrometheus,
  getMetricsSnapshot,
  computeErrorBudgetConsumed,
  instrumentHandler,
  resetMetrics,
  LATENCY_BUCKETS,
} from "../../src/sse/services/metrics.js";

beforeEach(() => {
  resetMetrics();
});

// --- counters --------------------------------------------------------------

describe("incrementCounter", () => {
  it("starts at zero and accumulates", () => {
    incrementCounter("sse_requests_total", { status: "2xx" });
    incrementCounter("sse_requests_total", { status: "2xx" });
    expect(getMetricsSnapshot().counters['sse_requests_total{status="2xx"}']).toBe(2);
  });

  it("keeps distinct label sets apart", () => {
    incrementCounter("sse_requests_total", { status: "2xx" });
    incrementCounter("sse_requests_total", { status: "5xx" });
    const counters = getMetricsSnapshot().counters;
    expect(counters['sse_requests_total{status="2xx"}']).toBe(1);
    expect(counters['sse_requests_total{status="5xx"}']).toBe(1);
  });

  it("drops null and undefined label values", () => {
    incrementCounter("sse_requests_total", { status: "2xx", provider: undefined, model: null });
    expect(getMetricsSnapshot().counters['sse_requests_total{status="2xx"}']).toBe(1);
  });
});

// --- gauges ----------------------------------------------------------------

describe("gauges", () => {
  it("sets an absolute value", () => {
    setGauge("sse_pending_requests", 7);
    expect(getMetricsSnapshot().gauges["sse_pending_requests"]).toBe(7);
  });

  it("adjusts by a delta", () => {
    setGauge("sse_pending_requests", 2);
    addGauge("sse_pending_requests", 3);
    addGauge("sse_pending_requests", -1);
    expect(getMetricsSnapshot().gauges["sse_pending_requests"]).toBe(4);
  });

  it("treats an absent gauge as zero when adjusting", () => {
    addGauge("sse_pending_requests", 5);
    expect(getMetricsSnapshot().gauges["sse_pending_requests"]).toBe(5);
  });
});

// --- latency histogram -----------------------------------------------------

describe("observeLatency", () => {
  it("counts observations and accumulates the sum", () => {
    observeLatency("sse_request_latency_seconds", 500, {});
    observeLatency("sse_request_latency_seconds", 1500, {});
    const entry = getMetricsSnapshot().histograms["sse_request_latency_seconds"];
    expect(entry.count).toBe(2);
    expect(entry.sum).toBeCloseTo(2, 5);
  });

  it("files an observation into the first matching bucket", () => {
    // 0.2s falls in the 0.25s bucket, so every bucket from 0.25s up includes it.
    observeLatency("sse_request_latency_seconds", 200, {});
    const entry = getMetricsSnapshot().histograms["sse_request_latency_seconds"];
    const idx = LATENCY_BUCKETS.indexOf(0.25);
    expect(entry.buckets[idx]).toBe(1);
    expect(entry.buckets[idx - 1]).toBe(0);
  });

  it("keeps memory bounded — the bucket count never grows with traffic", () => {
    for (let i = 0; i < 5000; i++) {
      observeLatency("sse_request_latency_seconds", 100 + i, { provider: "openai" });
    }
    const entry = getMetricsSnapshot().histograms['sse_request_latency_seconds{provider="openai"}'];
    expect(entry.buckets).toHaveLength(LATENCY_BUCKETS.length);
    expect(entry.count).toBe(5000);
  });
});

// --- recordRequest ---------------------------------------------------------

describe("recordRequest", () => {
  it("counts a successful request", () => {
    recordRequest({ status: 200, provider: "openai", endpoint: "/v1/chat/completions", durationMs: 120 });
    const counters = getMetricsSnapshot().counters;
    expect(counters['sse_requests_total{status="2xx",provider="openai",endpoint="/v1/chat/completions"}']).toBe(1);
    expect(counters['sse_error_responses_total{provider="openai",endpoint="/v1/chat/completions"}']).toBeUndefined();
  });

  it("counts a server error", () => {
    recordRequest({ status: 503, provider: "openai", endpoint: "/v1/chat/completions" });
    const counters = getMetricsSnapshot().counters;
    expect(counters['sse_requests_total{status="5xx",provider="openai",endpoint="/v1/chat/completions"}']).toBe(1);
    expect(counters['sse_error_responses_total{provider="openai",endpoint="/v1/chat/completions"}']).toBe(1);
  });

  it("does not count a 4xx as a server error", () => {
    recordRequest({ status: 401, provider: "openai" });
    const counters = getMetricsSnapshot().counters;
    expect(counters['sse_requests_total{status="4xx",provider="openai"}']).toBe(1);
    expect(Object.keys(counters).some((k) => k.startsWith("sse_error_responses_total"))).toBe(false);
  });

  it("normalises an unusable status to unknown", () => {
    recordRequest({ status: "not-a-number" });
    expect(getMetricsSnapshot().counters['sse_requests_total{status="unknown"}']).toBe(1);
  });
});

// --- error budget ----------------------------------------------------------

describe("computeErrorBudgetConsumed", () => {
  it("is zero when there has been no traffic", () => {
    expect(computeErrorBudgetConsumed()).toBe(0);
  });

  it("is zero when every request succeeded", () => {
    recordRequest({ status: 200 });
    expect(computeErrorBudgetConsumed()).toBe(0);
  });

  it("grows with the error rate", () => {
    recordRequest({ status: 200 });
    recordRequest({ status: 500 });
    // 50% error rate against a 0.05% budget -> far past exhausted.
    expect(computeErrorBudgetConsumed()).toBe(1);
  });

  it("respects a custom target error rate", () => {
    recordRequest({ status: 200 });
    recordRequest({ status: 500 });
    // 50% errors against a 50% budget -> exactly half consumed.
    expect(computeErrorBudgetConsumed(0.5)).toBeCloseTo(1, 5);
  });

  it("never exceeds 1", () => {
    recordRequest({ status: 500 });
    recordRequest({ status: 500 });
    expect(computeErrorBudgetConsumed(0.0001)).toBeLessThanOrEqual(1);
  });
});

// --- Prometheus rendering --------------------------------------------------

describe("renderPrometheus", () => {
  it("emits a TYPE line and the series for each counter", () => {
    recordRequest({ status: 200, provider: "openai", endpoint: "/v1/chat/completions" });
    const out = renderPrometheus();
    expect(out).toContain("# TYPE sse_requests_total counter");
    expect(out).toContain('sse_requests_total{status="2xx",provider="openai",endpoint="/v1/chat/completions"} 1');
  });

  it("emits gauge series", () => {
    setGauge("sse_error_budget_consumed", 0.25);
    const out = renderPrometheus();
    expect(out).toContain("# TYPE sse_error_budget_consumed gauge");
    expect(out).toContain("sse_error_budget_consumed 0.25");
  });

  it("emits histogram buckets, sum and count", () => {
    observeLatency("sse_request_latency_seconds", 300, { provider: "openai" });
    const out = renderPrometheus();
    expect(out).toContain("# TYPE sse_request_latency_seconds histogram");
    expect(out).toContain('sse_request_latency_seconds_bucket{provider="openai",le="0.5"} 1');
    expect(out).toContain('sse_request_latency_seconds_bucket{provider="openai",le="+Inf"} 1');
    expect(out).toContain('sse_request_latency_seconds_count{provider="openai"} 1');
    expect(out).toContain('sse_request_latency_seconds_sum{provider="openai"}');
  });

  it("escapes quotes in label values", () => {
    incrementCounter("sse_test_counter", { label: 'a"b' });
    expect(renderPrometheus()).toContain('sse_test_counter{label="a\\"b"} 1');
  });

  it("renders an empty registry without throwing", () => {
    expect(renderPrometheus()).toBe("");
  });
});

// --- instrumentHandler -----------------------------------------------------

describe("instrumentHandler", () => {
  function fakeRequest(path = "/v1/chat/completions") {
    return { url: `https://example.test${path}` };
  }

  it("records the status of a successful response", async () => {
    const wrapped = instrumentHandler(async () => new Response("ok", { status: 200 }));
    const res = await wrapped(fakeRequest());
    expect(res.status).toBe(200);
    expect(getMetricsSnapshot().counters['sse_requests_total{status="2xx",endpoint="/v1/chat/completions"}']).toBe(1);
  });

  it("records the status of an error response", async () => {
    const wrapped = instrumentHandler(async () => new Response("nope", { status: 503 }));
    await wrapped(fakeRequest());
    const counters = getMetricsSnapshot().counters;
    expect(counters['sse_requests_total{status="5xx",endpoint="/v1/chat/completions"}']).toBe(1);
    expect(counters['sse_error_responses_total{endpoint="/v1/chat/completions"}']).toBe(1);
  });

  it("records a thrown error as a 5xx and re-throws it", async () => {
    const wrapped = instrumentHandler(async () => {
      throw new Error("boom");
    });
    await expect(wrapped(fakeRequest())).rejects.toThrow("boom");
    expect(getMetricsSnapshot().counters['sse_requests_total{status="5xx",endpoint="/v1/chat/completions"}']).toBe(1);
  });

  it("passes extra arguments through to the handler", async () => {
    const wrapped = instrumentHandler(async (req, extra) => new Response(String(extra)));
    const res = await wrapped(fakeRequest(), "payload");
    expect(await res.text()).toBe("payload");
  });

  it("uses the static endpoint label when provided", async () => {
    const wrapped = instrumentHandler(async () => new Response("ok"), { endpoint: "/static" });
    await wrapped(fakeRequest());
    expect(getMetricsSnapshot().counters['sse_requests_total{status="2xx",endpoint="/static"}']).toBe(1);
  });
});
