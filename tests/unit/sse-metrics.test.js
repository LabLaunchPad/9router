import { describe, expect, it, beforeEach } from "vitest";

import {
  incrementCounter,
  setGauge,
  addGauge,
  observeLatency,
  recordRequest,
  recordBreakerRejection,
  renderPrometheus,
  getMetricsSnapshot,
  computeErrorBudgetConsumed,
  instrumentHandler,
  resetMetrics,
  endpointTemplate,
  getDroppedSeriesCount,
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

// --- the endpoint label is a route template, not a path ---------------------

describe("endpointTemplate", () => {
  it("maps the known routes onto themselves", () => {
    expect(endpointTemplate("/v1/chat/completions")).toBe("/v1/chat/completions");
    expect(endpointTemplate("/v1/messages")).toBe("/v1/messages");
    expect(endpointTemplate("/v1/responses")).toBe("/v1/responses");
    expect(endpointTemplate("/v1/responses/compact")).toBe("/v1/responses/compact");
    expect(endpointTemplate("/v1/api/chat")).toBe("/v1/api/chat");
    expect(endpointTemplate("/api/v1beta/models")).toBe("/api/v1beta/models");
  });

  it("collapses a client-chosen path onto a template", () => {
    // The catch-all route accepts an arbitrary suffix, and the suffix is
    // chosen by the caller.
    expect(endpointTemplate("/api/v1beta/models/gemini-2.0-flash:generateContent")).toBe(
      "/api/v1beta/models",
    );
    expect(endpointTemplate("/api/v1beta/models/a/b/c/d/e")).toBe("/api/v1beta/models");
  });

  it("does not let a longer path smuggle a new template past a shorter one", () => {
    // `/v1/responses/compact` must not be matched by `/v1/responses`.
    expect(endpointTemplate("/v1/responses/compact")).toBe("/v1/responses/compact");
  });

  it("collapses an unknown path to a single value", () => {
    expect(endpointTemplate("/whatever/this/is")).toBe("other");
    expect(endpointTemplate("")).toBe("other");
    expect(endpointTemplate(undefined)).toBe("other");
  });

  it("ignores a trailing slash", () => {
    expect(endpointTemplate("/v1/chat/completions/")).toBe("/v1/chat/completions");
  });
});

describe("the metric registry cannot be grown by the caller", () => {
  function requestFor(path) {
    return { url: `https://example.test${path}` };
  }

  it("records a client-chosen path as a route template, not as a path", async () => {
    const wrapped = instrumentHandler(async () => new Response("ok"));
    await wrapped(requestFor("/api/v1beta/models/random-1:generateContent"));
    const counters = getMetricsSnapshot().counters;
    expect(counters['sse_requests_total{status="2xx",endpoint="/api/v1beta/models"}']).toBe(1);
    // No series carries the client-chosen path.
    expect(Object.keys(counters).some((k) => k.includes("random-1"))).toBe(false);
  });

  it("keeps the number of series bounded when every request carries a new path", async () => {
    const wrapped = instrumentHandler(async () => new Response("ok"));
    for (let i = 0; i < 2000; i++) {
      await wrapped(requestFor(`/api/v1beta/models/model-${i}:generateContent`));
    }
    const counters = getMetricsSnapshot().counters;
    // One template, not 2000 series.
    expect(Object.keys(counters).length).toBeLessThan(20);
    expect(counters['sse_requests_total{status="2xx",endpoint="/api/v1beta/models"}']).toBe(2000);
  });

  it("counts a refused series as an error rather than dropping it", () => {
    // Fill the registry with distinct label sets.
    for (let i = 0; i < 600; i++) {
      incrementCounter("sse_requests_total", { status: "2xx", provider: `p${i}` });
    }
    expect(getDroppedSeriesCount()).toBeGreaterThan(0);

    // A request that cannot have its own series is counted as an error, so
    // the error rate the SLO gate reads cannot be understated.
    const before = computeErrorBudgetConsumed();
    recordRequest({ status: "2xx", provider: "brand-new-provider" });
    const after = computeErrorBudgetConsumed();
    expect(after).toBeGreaterThan(before);
  });

  it("counts an error whose own series cannot be created", () => {
    // The request's series exists, but the error it produced would need a
    // new one — and the registry is full. The error still has to be
    // counted, or the error rate the SLO gate reads is understated.
    incrementCounter("sse_requests_total", { status: "5xx", endpoint: "/v1/chat/completions" });
    for (let i = 0; i < 600; i++) {
      incrementCounter("sse_requests_total", { status: "2xx", provider: `p${i}` });
    }

    const before = computeErrorBudgetConsumed();
    recordRequest({ status: "5xx", endpoint: "/v1/chat/completions" });
    const after = computeErrorBudgetConsumed();

    const counters = getMetricsSnapshot().counters;
    expect(counters['sse_error_responses_total{endpoint="overflow"}']).toBe(1);
    expect(after).toBeGreaterThan(before);
  });
});

// --- breaker refusals -----------------------------------------------------

describe("recordBreakerRejection", () => {
  it("counts a refused request and moves the error budget", () => {
    // The refusal is a server-side failure: the client asked for something
    // and did not get it. The handler answers 404 — "no credentials" and
    // "the circuit is open" share one return value — so without an
    // explicit count the budget would not see it at all.
    for (let i = 0; i < 10; i += 1) {
      recordRequest({ status: 404, provider: "openai", endpoint: "/api/v1beta/models/x" });
    }

    // The 404s are requests, not errors: the budget is untouched.
    expect(computeErrorBudgetConsumed(1)).toBe(0);

    recordBreakerRejection("openai");

    const counters = getMetricsSnapshot().counters;
    expect(counters['sse_circuit_breaker_rejections_total{provider="openai"}']).toBe(1);

    // ONE error out of TEN requests. Against a target of 100% that is
    // exactly 0.1 of the budget consumed — the refusal moved it by exactly
    // what it should have.
    expect(computeErrorBudgetConsumed(1)).toBeCloseTo(0.1, 10);

    // And against the real 0.05% target it saturates: a provider refusing
    // a tenth of all traffic has certainly blown the budget.
    expect(computeErrorBudgetConsumed()).toBe(1);
  });

  it("makes a total outage visible to the gate", () => {
    // The case the gate exists for: the provider is entirely down and
    // every request is refused by the breaker. Before the refusal was
    // counted, this read as a PERFECT error budget, because the 404s were
    // counted as requests and never as errors — so the measured error rate
    // FELL as the outage got worse.
    for (let i = 0; i < 100; i += 1) {
      recordRequest({ status: 404, provider: "openai", endpoint: "/api/v1beta/models/x" });
      recordBreakerRejection("openai");
    }
    expect(computeErrorBudgetConsumed()).toBe(1);
  });

  it("counts a refusal whose own series cannot be created", () => {
    // A full registry must never understate the outage: the refusal goes
    // to the overflow ERROR series, which the budget reads.
    incrementCounter("sse_requests_total", { status: "2xx", endpoint: "/v1/chat/completions" });
    for (let i = 0; i < 600; i += 1) {
      incrementCounter("sse_requests_total", { status: "2xx", provider: `p${i}` });
    }

    const before = computeErrorBudgetConsumed(1);
    recordBreakerRejection("openai");
    const after = computeErrorBudgetConsumed(1);

    const counters = getMetricsSnapshot().counters;
    expect(counters['sse_error_responses_total{endpoint="overflow"}']).toBe(1);
    expect(after).toBeGreaterThan(before);
  });

  it("renders the refusal on the metrics endpoint", () => {
    recordBreakerRejection("openai");
    const text = renderPrometheus();
    expect(text).toContain("sse_circuit_breaker_rejections_total");
    expect(text).toContain('provider="openai"');
  });
});
