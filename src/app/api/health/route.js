import { getAllCircuitBreakerStates } from "open-sse/services/circuitBreaker.js";
import { computeErrorBudgetConsumed } from "@/sse/services/metrics.js";
import { structuredInfo, structuredWarn } from "@/sse/utils/logger.js";

/**
 * GET /api/health — operational health snapshot.
 *
 * Two distinct signals, deliberately kept separate:
 *
 *  - `ok` is LIVENESS: the service answered. It is always true for a 200
 *    response, so an existing probe that reads `ok` keeps working.
 *  - `status` is READINESS: the SLO state, derived from the remaining error
 *    budget ("ok" | "degraded"). A service whose error budget is burned
 *    reports `status: "degraded"` while still answering, because the HTTP
 *    status stays 200 — a load balancer should not pull a still-serving
 *    instance out of rotation over a soft SLO signal.
 *
 * Reports:
 *  - ok: true (kept for backwards compatibility with existing probes)
 *  - status: "ok" | "degraded" (derived from the error budget)
 *  - pendingRequests: in-flight request count, by model
 *  - activeConnections: connections with at least one in-flight request
 *  - droppedOnRestart: requests that were in flight when the process stopped
 *  - errorBudgetRemaining: fraction of the error budget still available
 *  - lastErrorProvider: the provider that most recently failed
 *  - circuitBreakerStates: per-provider breaker state
 *  - uptime: process uptime in seconds
 *
 * This endpoint intentionally exposes no request payloads, credentials, or
 * user data. It is safe to expose to internal monitoring.
 *
 * CORS: the dashboard pings other instances cross-origin (see
 * src/app/(dashboard)/dashboard/endpoint/endpointPing.js) and relies on this
 * route answering a `mode: "cors"` request. The CORS headers and the
 * OPTIONS handler are therefore part of the endpoint's contract, not an
 * optional extra.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Cache-Control": "no-store",
};

// Below this fraction of the error budget remaining the service is reported
// as degraded. The HTTP status stays 200 so a load balancer does not pull a
// still-serving instance out of rotation over a soft SLO signal.
const DEGRADED_BUDGET_THRESHOLD = 0.25;

function getPendingSummary() {
  const pending = global._pendingRequests;
  if (!pending) return { total: 0, byModel: {}, byAccount: {} };

  const byModel = {};
  let total = 0;
  for (const [modelKey, count] of Object.entries(pending.byModel || {})) {
    const n = Number(count) || 0;
    if (n > 0) {
      byModel[modelKey] = n;
      total += n;
    }
  }
  return { total, byModel, byAccount: pending.byAccount || {} };
}

function getErrorBudgetRemaining() {
  // Derived from the same counters the SLO gate reads, so the health view and
  // the deploy gate can never disagree.
  const consumed = computeErrorBudgetConsumed();
  if (consumed === null || Number.isNaN(consumed)) return null;
  return Math.max(0, Math.round((1 - consumed) * 10000) / 10000);
}

/**
 * Requests that were in flight when the previous process stopped.
 *
 * They were killed by the restart and will never complete, so they are
 * reported separately rather than folded into the live in-flight gauge —
 * nothing ever decrements a counter for a request that no longer exists.
 */
function getDroppedSummary() {
  const dropped = global._droppedOnRestart;
  if (!dropped) return { total: 0, at: null, byModel: {} };

  const byModel = {};
  let total = 0;
  for (const [modelKey, count] of Object.entries(dropped.byModel || {})) {
    const n = Number(count) || 0;
    if (n > 0) {
      byModel[modelKey] = n;
      total += n;
    }
  }
  return { total, at: dropped.at || null, byModel };
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  const pending = getPendingSummary();
  const budgetRemaining = getErrorBudgetRemaining();
  const dropped = getDroppedSummary();

  const breakerStates = {};
  try {
    for (const state of getAllCircuitBreakerStates()) {
      breakerStates[state.provider] = state.state;
    }
  } catch {
    // Circuit breaker registry unavailable — report as unknown rather than failing.
  }

  const lastError = global._lastErrorProvider;
  const uptime = Math.floor(process.uptime());

  // The status is derived from the error budget, not hardcoded. A service
  // whose error budget is fully burned must not report itself as "ok" —
  // that is the exact signal the SLO gate and the operator both act on.
  const degraded =
    budgetRemaining !== null && budgetRemaining < DEGRADED_BUDGET_THRESHOLD;

  const body = {
    ok: true,
    status: degraded ? "degraded" : "ok",
    pendingRequests: pending.total,
    pendingByModel: pending.byModel,
    activeConnections: Object.keys(pending.byAccount).length,
    droppedOnRestart: dropped.total,
    droppedOnRestartAt: dropped.at,
    droppedByModel: dropped.byModel,
    errorBudgetRemaining: budgetRemaining,
    lastErrorProvider: lastError?.provider || null,
    circuitBreakerStates: breakerStates,
    uptime,
  };

  const logFields = {
    pendingRequests: pending.total,
    droppedOnRestart: dropped.total,
    uptime,
    errorBudgetRemaining: body.errorBudgetRemaining,
    breakerCount: Object.keys(breakerStates).length,
  };

  if (degraded) {
    structuredWarn("health_error_budget_low", logFields);
  } else {
    structuredInfo("health_check", logFields);
  }

  return Response.json(body, {
    status: 200,
    headers: CORS_HEADERS,
  });
}
