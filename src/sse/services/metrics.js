// src/sse/services/metrics.js
//
// Minimal in-process metrics registry that renders Prometheus text format.
//
// Design notes (deliberately simple — no over-engineering):
//  - Latency is kept as a fixed-bucket histogram, not a raw sample array, so
//    memory usage is bounded regardless of traffic.
//  - Counters are plain Maps keyed by a pre-rendered label string. Series are
//    created lazily on first observation.
//  - No request payload, credential, header, or user data is ever recorded.
//    Only operational metadata: status class, provider, model, endpoint.

import { structuredWarn } from "../utils/logger.js";

// Latency buckets in seconds (Prometheus convention).
const LATENCY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

// The route templates the `endpoint` label may take.
//
// The label must be a FIXED set. The request path is client-controlled —
// `/api/v1beta/models/[...path]` accepts an arbitrary suffix — so a label
// taken from the raw path lets a caller mint a new metric series per
// request. The registry is never pruned, and `/api/metrics` is
// unauthenticated, so that is an unbounded registry behind a public
// endpoint: measured at 100 000 distinct paths, the rendered exposition was
// 167 MB and the process RSS 807 MB, and every scrape re-sorts and
// re-materialises the whole registry.
//
// So the label is a TEMPLATE, never a path. Longest first, so
// `/v1/responses/compact` is not matched by `/v1/responses`.
const ROUTE_TEMPLATES = [
  "/v1/chat/completions",
  "/v1/messages",
  "/v1/responses/compact",
  "/v1/responses",
  "/v1/api/chat",
  "/api/v1beta/models",
].sort((a, b) => b.length - a.length);

// The single label value used for anything that is not a known route.
const OTHER_ENDPOINT = "other";

/**
 * Map a request path onto a fixed route template.
 *
 * @param {string} pathname
 * @returns {string} one of ROUTE_TEMPLATES, or "other"
 */
export function endpointTemplate(pathname) {
  if (typeof pathname !== "string" || pathname === "") return OTHER_ENDPOINT;
  const p = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  for (const t of ROUTE_TEMPLATES) {
    if (p === t || p.startsWith(`${t}/`) || p.startsWith(`${t}:`)) return t;
  }
  return OTHER_ENDPOINT;
}

// A hard ceiling on the number of series in any one map.
//
// This is a BACKSTOP, not the primary defence: with the endpoint label
// templated, the label set is fixed and the registry cannot grow without
// bound. It is here so that a future label cannot reintroduce the problem
// silently.
//
// When the ceiling is reached, a new series is not created. The event is
// counted as an ERROR instead — dropped as a success, the error rate would
// be under-reported and the SLO gate would wave through a deploy that
// should have been blocked. An unknown is not evidence that the service is
// innocent.
const MAX_SERIES = 500;
let droppedSeries = 0;
let dropWarned = false;

// The overflow series are created up front, so they always exist.
//
// A registry at its ceiling must still be able to record that something was
// dropped — and creating a series is exactly what it can no longer do. They
// count as ERRORS, so a full registry can never understate the error rate
// the SLO gate reads. A request the gate cannot account for is not evidence
// that the service is innocent.
const OVERFLOW_LABELS = { status: "5xx", endpoint: "overflow" };
const OVERFLOW_ERROR_LABELS = { endpoint: "overflow" };

// The registry lives on globalThis under a namespaced key.
//
// The producer (the chat routes) and the exporter (/api/metrics) must see the
// same counters. They do today because the bundler happens to emit one shared
// module instance, but nothing enforced that: per-route bundling, Turbopack,
// or moving the exporter into a different runtime would give /api/metrics its
// own empty registry — and the CI SLO gate would read
// `sse_error_budget_consumed 0`, i.e. a permanently healthy budget.
//
// Keeping the state on globalThis makes the sharing explicit and survives a
// re-bundle, the same way initializeApp.js keeps its singleton.
const REGISTRY_KEY = "__9router_sse_metrics_registry__";
const registry = globalThis[REGISTRY_KEY] || {
  counters: new Map(),
  gauges: new Map(),
  histograms: new Map(),
};
globalThis[REGISTRY_KEY] = registry;

const { counters, gauges, histograms } = registry;

function counterKey(labels) {
  return renderLabels(labels);
}

function renderLabels(labels) {
  if (!labels) return "";
  const entries = Object.entries(labels).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(",")}}`;
}

// The overflow series are created up front, so they always exist.
//
// A registry at its ceiling must still be able to record that something was
// dropped — and creating a series is exactly what it can no longer do. They
// count as ERRORS, so a full registry can never understate the error rate
// the SLO gate reads. A request the gate cannot account for is not evidence
// that the service is innocent.
counters.set(`sse_requests_total${counterKey(OVERFLOW_LABELS)}`, 0);
counters.set(`sse_error_responses_total${counterKey(OVERFLOW_ERROR_LABELS)}`, 0);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Increment a counter.
 * @param {string} name e.g. "sse_requests_total"
 * @param {object} [labels] e.g. { status: "200", provider: "openai" }
 */
export function incrementCounter(name, labels) {
  const key = `${name}${counterKey(labels)}`;
  if (counters.has(key)) {
    counters.set(key, counters.get(key) + 1);
    return;
  }
  if (counters.size >= MAX_SERIES) {
    noteDroppedSeries(name, labels);
    return;
  }
  counters.set(key, 1);
}

/**
 * Record that a series could not be created because the registry is at its
 * ceiling.
 *
 * The event is counted as an error rather than dropped, so the error rate
 * the SLO gate reads cannot be understated by a full registry. Warned once:
 * a caller that mints a series per request would otherwise produce one
 * warning per request, which is its own resource problem.
 */
function noteDroppedSeries(name, labels) {
  droppedSeries += 1;
  if (dropWarned) return;
  dropWarned = true;
  structuredWarn("metrics_series_dropped", {
    name,
    series: counters.size,
    limit: MAX_SERIES,
  });
}

/**
 * Set a gauge to an absolute value.
 * @param {string} name e.g. "sse_pending_requests"
 * @param {number} value
 * @param {object} [labels]
 */
export function setGauge(name, value, labels) {
  const key = `${name}${counterKey(labels)}`;
  if (!gauges.has(key) && gauges.size >= MAX_SERIES) {
    noteDroppedSeries(name, labels);
    return;
  }
  gauges.set(key, value);
}

/**
 * Adjust a gauge by a delta.
 * @param {string} name
 * @param {number} delta
 * @param {object} [labels]
 */
export function addGauge(name, delta, labels) {
  const key = `${name}${counterKey(labels)}`;
  if (!gauges.has(key)) {
    if (gauges.size >= MAX_SERIES) {
      noteDroppedSeries(name, labels);
      return;
    }
    gauges.set(key, delta);
    return;
  }
  gauges.set(key, gauges.get(key) + delta);
}

/**
 * Observe a latency value (milliseconds) into a labelled histogram.
 * @param {string} name e.g. "sse_request_latency_seconds"
 * @param {number} durationMs
 * @param {object} [labels]
 */
export function observeLatency(name, durationMs, labels) {
  const seconds = durationMs / 1000;
  const key = `${name}${counterKey(labels)}`;
  let entry = histograms.get(key);
  if (!entry) {
    if (histograms.size >= MAX_SERIES) {
      noteDroppedSeries(name, labels);
      return;
    }
    entry = { buckets: new Array(LATENCY_BUCKETS.length).fill(0), sum: 0, count: 0, labels: labels || {} };
    histograms.set(key, entry);
  }
  entry.sum += seconds;
  entry.count += 1;
  for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
    if (seconds <= LATENCY_BUCKETS[i]) entry.buckets[i] += 1;
  }
}

/**
 * Record a completed SSE request: increments the request counter and observes latency.
 * @param {{ status?: number|string, provider?: string, model?: string, endpoint?: string, durationMs?: number }} info
 */
export function recordRequest({ status, provider, model, endpoint, durationMs } = {}) {
  const statusClass = normalizeStatus(status);
  const labels = { status: statusClass };
  if (provider) labels.provider = provider;
  if (model) labels.model = model;
  // The endpoint is the LABEL, already final. `instrumentHandler` is the
  // only caller, and it is where a client-controlled path is mapped onto a
  // route template.
  if (endpoint) labels.endpoint = endpoint;

  // The registry is at its ceiling and this request would need a new series.
  // It is recorded in the overflow series instead, as an ERROR: dropping it
  // as a success would understate the error rate the SLO gate reads, and the
  // gate would wave through a deploy that should have been blocked.
  const requestKey = `sse_requests_total${counterKey(labels)}`;
  if (!counters.has(requestKey) && counters.size >= MAX_SERIES) {
    // Note: the request's own series is NOT created — that is the whole
    // point of the ceiling. The event goes to the overflow series, as one
    // request and one error.
    incrementOverflowRequest();
    incrementOverflowError();
    noteDroppedSeries("sse_requests_total", labels);
    return;
  }

  incrementCounter("sse_requests_total", labels);
  if (statusClass === "5xx") {
    const errorLabels = { provider, endpoint };
    const errorKey = `sse_error_responses_total${counterKey(errorLabels)}`;
    if (!counters.has(errorKey) && counters.size >= MAX_SERIES) {
      // The request has its own series, but the ERROR it produced cannot
      // have one. The error still has to be counted, or the error rate is
      // understated — so it goes to the overflow error series.
      incrementOverflowError();
      noteDroppedSeries("sse_error_responses_total", errorLabels);
    } else {
      incrementCounter("sse_error_responses_total", errorLabels);
    }
  }
  if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
    observeLatency("sse_request_latency_seconds", durationMs, { provider, endpoint });
  }
}

/**
 * Record a request that the circuit breaker refused.
 *
 * The refusal is a SERVER-side failure of the provider: the client asked for
 * something and did not get it. The handler happens to answer 404 — because
 * "no credentials" and "the provider's circuit is open" share one return
 * value — but the error budget has to see it.
 *
 * Counting only 5xx would make a total outage behind an open circuit read as
 * a PERFECT error budget, because the refusals are counted as requests and
 * not as errors: the measured error rate would FALL as the outage got
 * worse. The SLO gate would then wave the deploy through, for exactly the
 * failure the breaker exists to contain.
 *
 * The series is created only when the registry has room. When it does not,
 * the refusal is counted in the overflow ERROR series — a full registry must
 * never understate the outage, which is what the overflow series is for.
 *
 * @param {string} provider
 */
export function recordBreakerRejection(provider) {
  const labels = { provider };
  const key = `sse_circuit_breaker_rejections_total${counterKey(labels)}`;
  if (!counters.has(key) && counters.size >= MAX_SERIES) {
    incrementOverflowError();
    noteDroppedSeries("sse_circuit_breaker_rejections_total", labels);
    return;
  }
  incrementCounter("sse_circuit_breaker_rejections_total", labels);
}

/**
 * Count one request in the overflow series.
 */
function incrementOverflowRequest() {
  const key = `sse_requests_total${counterKey(OVERFLOW_LABELS)}`;
  counters.set(key, (counters.get(key) || 0) + 1);
}

/**
 * Count one error in the overflow series.
 */
function incrementOverflowError() {
  const key = `sse_error_responses_total${counterKey(OVERFLOW_ERROR_LABELS)}`;
  counters.set(key, (counters.get(key) || 0) + 1);
}

/**
 * How many series the registry had to refuse.
 *
 * Published so that a full registry is visible rather than silent.
 *
 * @returns {number}
 */
export function getDroppedSeriesCount() {
  return droppedSeries;
}

/**
 * Wrap a request handler so its outcome lands in the metrics registry.
 *
 * The wrapper never changes the handler's behaviour: the response is returned
 * untouched, and a thrown error is re-thrown after being counted.
 *
 * Known limitation: for a streaming response the status is fixed at 200 once
 * the headers are committed, so a stream that fails mid-flight is counted as a
 * success. The error budget therefore under-counts mid-stream failures; a
 * more accurate source can feed the `sse_error_budget_consumed` gauge
 * directly (see computeErrorBudgetConsumed).
 *
 * @param {Function} handler - (request, ...rest) => Promise<Response>
 * @param {object} [meta] - { provider, endpoint } static labels
 * @returns {Function} instrumented handler
 */
export function instrumentHandler(handler, meta = {}) {
  return async function instrumented(request, ...rest) {
    const startedAt = Date.now();
    let status;
    try {
      const response = await handler(request, ...rest);
      status = response?.status;
      return response;
    } catch (err) {
      status = 500;
      throw err;
    } finally {
      let endpoint = meta.endpoint;
      if (!endpoint) {
        // The request path is CLIENT-CONTROLLED — `/api/v1beta/models/[...path]`
        // accepts an arbitrary suffix — so it is mapped onto a fixed route
        // template rather than used as the label. A label taken from the raw
        // path would let a caller mint a new metric series per request.
        // `meta.endpoint` is code-supplied and static, so it is used as given.
        try {
          endpoint = endpointTemplate(new URL(request?.url).pathname);
        } catch {
          endpoint = undefined;
        }
      }
      recordRequest({
        status,
        provider: meta.provider,
        endpoint,
        durationMs: Date.now() - startedAt,
      });
    }
  };
}

function normalizeStatus(status) {
  if (status === undefined || status === null) return "unknown";
  const n = Number(status);
  if (!Number.isFinite(n)) return "unknown";
  if (n < 100 || n > 599) return "unknown";
  return `${Math.floor(n / 100)}xx`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the registry in Prometheus text exposition format.
 * @returns {string}
 */
export function renderPrometheus() {
  const lines = [];

  // Counters
  const counterNames = new Set();
  for (const key of counters.keys()) {
    counterNames.add(key.replace(/\{.*$/, ""));
  }
  for (const name of [...counterNames].sort()) {
    lines.push(`# TYPE ${name} counter`);
    for (const [key, value] of [...counters.entries()].sort()) {
      if (!key.startsWith(name)) continue;
      const series = key.slice(name.length);
      lines.push(`${name}${series} ${value}`);
    }
  }

  // Gauges
  const gaugeNames = new Set();
  for (const key of gauges.keys()) {
    gaugeNames.add(key.replace(/\{.*$/, ""));
  }
  for (const name of [...gaugeNames].sort()) {
    lines.push(`# TYPE ${name} gauge`);
    for (const [key, value] of [...gauges.entries()].sort()) {
      if (!key.startsWith(name)) continue;
      const series = key.slice(name.length);
      lines.push(`${name}${series} ${value}`);
    }
  }

  // Histograms
  const histNames = new Set();
  for (const key of histograms.keys()) {
    histNames.add(key.replace(/\{.*$/, ""));
  }
  for (const name of [...histNames].sort()) {
    lines.push(`# TYPE ${name} histogram`);
    for (const [key, entry] of [...histograms.entries()].sort()) {
      if (!key.startsWith(name)) continue;
      const labelPart = key.slice(name.length) || "";
      // `labelPart` is a full label set such as {provider="openai"} (or "").
      // The `le` label is inserted before the closing brace.
      const leLabel = (le) => (labelPart ? `${labelPart.slice(0, -1)},le="${le}"}` : `{le="${le}"}`);
      for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
        lines.push(`${name}_bucket${leLabel(LATENCY_BUCKETS[i])} ${entry.buckets[i]}`);
      }
      lines.push(`${name}_bucket${leLabel("+Inf")} ${entry.count}`);
      lines.push(`${name}_sum${labelPart} ${entry.sum}`);
      lines.push(`${name}_count${labelPart} ${entry.count}`);
    }
  }

  return lines.join("\n");
}

/**
 * Reset all collected metrics. Intended for tests only.
 */
export function resetMetrics() {
  counters.clear();
  gauges.clear();
  histograms.clear();
}

/**
 * Current registry snapshot as a plain object. Intended for the health
 * endpoint and tests.
 */
export function getMetricsSnapshot() {
  return {
    counters: Object.fromEntries(counters),
    gauges: Object.fromEntries(gauges),
    histograms: Object.fromEntries(
      [...histograms.entries()].map(([key, e]) => [
        key,
        { count: e.count, sum: e.sum, buckets: [...e.buckets] },
      ]),
    ),
  };
}

/**
 * Compute error-budget consumption as a 0..1 fraction.
 *
 * Derives from the recorded request counters:
 *   errorRate = (5xx responses + breaker refusals) / total responses
 *   consumed  = errorRate / targetErrorRate
 *
 * With a 99.95% availability target the error budget is 0.05% of requests.
 *
 * The breaker refusals are part of the error count because they are
 * server-side failures: the provider is down and the client got nothing.
 * Without them, a total outage behind an open circuit would consume no
 * budget at all — the refusals would be counted as requests but never as
 * errors, and the measured error rate would fall as the outage got worse.
 *
 * @param {number} [targetErrorRate] default 0.0005
 * @returns {number} fraction of budget consumed (0 when no traffic yet)
 */
export function computeErrorBudgetConsumed(targetErrorRate = 0.0005) {
  let total = 0;
  let errors = 0;
  for (const [key, value] of counters.entries()) {
    if (key.startsWith("sse_requests_total")) total += value;
    if (key.startsWith("sse_error_responses_total")) errors += value;
    if (key.startsWith("sse_circuit_breaker_rejections_total")) errors += value;
  }
  if (total === 0) return 0;
  const errorRate = errors / total;
  if (targetErrorRate <= 0) return 1;
  return Math.min(1, errorRate / targetErrorRate);
}

export { LATENCY_BUCKETS };
