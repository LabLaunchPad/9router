import {
  renderPrometheus,
  computeErrorBudgetConsumed,
  setGauge,
} from "@/sse/services/metrics.js";
import { getAllCircuitBreakerStates } from "open-sse/services/circuitBreaker.js";
import { structuredInfo } from "@/sse/utils/logger.js";

/**
 * GET /metrics — Prometheus text exposition endpoint.
 *
 * Exposes operational metrics only. No request payloads, credentials,
 * headers, or user data are included.
 *
 * The `sse_error_budget_consumed` gauge is derived from the recorded
 * request counters and is what the CI SLO gate queries.
 */

export async function GET() {
  // Refresh gauges that are computed on demand.
  setGauge("sse_error_budget_consumed", Number(computeErrorBudgetConsumed().toFixed(6)));

  // The counters behind the metric live in this process, so they only cover
  // the time since the last restart. Publish the sample age so the CI SLO
  // gate can tell whether the metric actually spans the SLO window instead of
  // assuming it does.
  setGauge("sse_metrics_sample_age_seconds", Math.floor(process.uptime()));

  try {
    for (const state of getAllCircuitBreakerStates()) {
      // 0 = closed, 1 = half-open, 2 = open (higher = more severe).
      const numeric = state.state === "open" ? 2 : state.state === "half-open" ? 1 : 0;
      setGauge("sse_circuit_breaker_state", numeric, { provider: state.provider });
    }
  } catch {
    // Registry unavailable — the gauge simply will not be present.
  }

  const body = renderPrometheus();

  structuredInfo("metrics_scraped", { bytes: body.length });

  return new Response(`${body}\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
