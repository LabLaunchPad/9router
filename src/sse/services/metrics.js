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
  counters.set(key, (counters.get(key) || 0) + 1);
}

/**
 * Set a gauge to an absolute value.
 * @param {string} name e.g. "sse_pending_requests"
 * @param {number} value
 * @param {object} [labels]
 */
export function setGauge(name, value, labels) {
  const key = `${name}${counterKey(labels)}`;
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
  gauges.set(key, (gauges.get(key) || 0) + delta);
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
  if (endpoint) labels.endpoint = endpoint;

  incrementCounter("sse_requests_total", labels);
  if (statusClass === "5xx") {
    incrementCounter("sse_error_responses_total", { provider, endpoint });
  }
  if (typeof durationMs === "number" && Number.isFinite(durationMs)) {
    observeLatency("sse_request_latency_seconds", durationMs, { provider, endpoint });
  }
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
        try {
          endpoint = new URL(request?.url).pathname;
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
 *   errorRate = 5xx responses / total responses
 *   consumed  = errorRate / targetErrorRate
 *
 * With a 99.95% availability target the error budget is 0.05% of requests.
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
  }
  if (total === 0) return 0;
  const errorRate = errors / total;
  if (targetErrorRate <= 0) return 1;
  return Math.min(1, errorRate / targetErrorRate);
}

export { LATENCY_BUCKETS };
