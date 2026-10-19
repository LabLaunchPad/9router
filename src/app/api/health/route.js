import { getAllCircuitBreakerStates } from "open-sse/services/circuitBreaker.js";
import { computeErrorBudgetConsumed } from "@/sse/services/metrics.js";
import { structuredInfo, structuredWarn } from "@/sse/utils/logger.js";

/**
 * GET /api/health — operational health snapshot.
 *
 * Reports:
 *  - pendingRequests: in-flight request count, by model
 *  - activeConnections: connections with at least one in-flight request
 *  - errorBudgetRemaining: fraction of the error budget still available
 *  - lastErrorProvider: the provider that most recently failed
 *  - circuitBreakerStates: per-provider breaker state
 *  - uptime: process uptime in seconds
 *
 * This endpoint intentionally exposes no request payloads, credentials, or
 * user data. It is safe to expose to internal monitoring.
 */

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

export async function GET() {
  const pending = getPendingSummary();
  const budgetRemaining = getErrorBudgetRemaining();

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

  const body = {
    status: "ok",
    pendingRequests: pending.total,
    pendingByModel: pending.byModel,
    activeConnections: Object.keys(pending.byAccount).length,
    errorBudgetRemaining: budgetRemaining,
    lastErrorProvider: lastError?.provider || null,
    circuitBreakerStates: breakerStates,
    uptime,
  };

  const logFields = {
    pendingRequests: pending.total,
    uptime,
    errorBudgetRemaining: body.errorBudgetRemaining,
    breakerCount: Object.keys(breakerStates).length,
  };

  if (body.errorBudgetRemaining !== null && body.errorBudgetRemaining < 0.25) {
    structuredWarn("health_error_budget_low", logFields);
  } else {
    structuredInfo("health_check", logFields);
  }

  return Response.json(body, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
}
