#!/usr/bin/env node
/**
 * SLO Validation Gate for 9router CI/CD
 *
 * Queries a Prometheus-compatible metrics endpoint, evaluates error-budget
 * consumption against configurable thresholds, and exits with:
 *   0 -> deployment allowed
 *   1 -> deployment blocked (fail-closed on missing/invalid data by default)
 *   2 -> warning: manual approval required
 *
 * All thresholds are environment-configurable; see `docs/SLO_GATE.md`.
 *
 * Security: this script only reads metrics. It never logs secrets, request
 * bodies, or user data.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  // The metrics endpoint to scrape.
  //
  // `METRICS_ENDPOINT` is an accepted alias of `SLO_METRICS_ENDPOINT`. It is
  // documented here and in PRODUCTION_READINESS_CONTROLS.md because a
  // generically-named variable in the environment silently supplying an
  // endpoint would otherwise be a surprise.
  metricsEndpoint: process.env.SLO_METRICS_ENDPOINT || process.env.METRICS_ENDPOINT || "",
  serviceName: process.env.SERVICE_NAME || "9router",
  environment: process.env.ENVIRONMENT || "production",
  gitSha: process.env.GITHUB_SHA || "unknown",
  actor: process.env.GITHUB_ACTOR || process.env.USER || "unknown",

  // Budget consumption thresholds (percent of the 30-day error budget)
  warningThreshold: numEnv("SLO_WARNING_THRESHOLD", 50),
  blockedThreshold: numEnv("SLO_BLOCKED_THRESHOLD", 75),
  exhaustedThreshold: numEnv("SLO_EXHAUSTED_THRESHOLD", 95),

  // SLO window in seconds (default 30 days)
  windowSeconds: numEnv("SLO_WINDOW_SECONDS", 30 * 24 * 60 * 60),

  // The error budget allowance, as a fraction of requests. Must match the
  // app's own target (see computeErrorBudgetConsumed in
  // src/sse/services/metrics.js): 0.0005 == a 99.95% availability SLO.
  //
  // Without this the counter fallback would report the raw error RATE and
  // compare it against budget-consumption thresholds — off by 1/targetErrorRate.
  targetErrorRate: numEnv("SLO_TARGET_ERROR_RATE", 0.0005),

  // The counters behind the metric live in the service process, so they only
  // cover the time since the last restart. A sample that does not span the
  // SLO window cannot validate the SLO, so the gate fails closed on it.
  // Set SLO_REQUIRE_FULL_WINDOW=false to downgrade this to a warning.
  requireFullWindow: (process.env.SLO_REQUIRE_FULL_WINDOW || "true") !== "false",

  // Fail-closed: block when metrics are unavailable or malformed.
  //
  // This covers a missing endpoint as well: a gate that has no endpoint to
  // read cannot say anything about the error budget, so it blocks. The
  // explicit ways to release a deploy are `SLO_GATE_SKIP` and the audited
  // `SLO_GATE_OVERRIDE_APPROVED` — never an implicit fail-open.
  failClosed: (process.env.SLO_FAIL_CLOSED || "true") !== "false",

  // Skip the gate entirely. CI-only: the workflow step is skipped, so the
  // deploy is not validated against the error budget. Always visible in the
  // job summary.
  skip: process.env.SLO_GATE_SKIP === "true",

  // Emergency override (audited).
  // `SLO_GATE_OVERRIDE` is an accepted alias of `SLO_GATE_OVERRIDE_APPROVED`;
  // both are documented, and the audit trail records the actor, the reason
  // and the git SHA either way.
  overrideApproved:
    process.env.SLO_GATE_OVERRIDE_APPROVED === "true" ||
    process.env.SLO_GATE_OVERRIDE === "true",
  overrideReason: process.env.SLO_GATE_OVERRIDE_REASON || "unspecified",
};

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Prometheus text parsing
// ---------------------------------------------------------------------------

/**
 * Extract the numeric value of a metric from Prometheus text exposition.
 * Handles both `name value` and `name{labels} value` forms.
 * Returns null when the metric is absent.
 */
export function parseMetric(text, name) {
  if (!text) return null;
  const lines = text.split("\n");
  let value = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // Exact metric name or metric with label set
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escaped}(\\{[^}]*\\})?\\s+(\\S+)$`);
    const m = line.match(re);
    if (!m) continue;
    const parsed = Number(m[2]);
    if (Number.isFinite(parsed)) value = parsed;
  }

  return value;
}

/**
 * Sum every series of a metric from Prometheus text exposition.
 *
 * The app exports one series per label combination, e.g.
 *   sse_requests_total{status="2xx",provider="openai"} 990
 *   sse_requests_total{status="5xx",provider="openai"} 5
 * Reading a single one of those is meaningless for a total, so counters must
 * be summed. `parseMetric` is only correct for single-series gauges.
 *
 * @returns {number|null} the sum, or null when the metric is absent
 */
export function sumMetric(text, name) {
  if (!text) return null;
  const lines = text.split("\n");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}(\\{[^}]*\\})?\\s+(\\S+)$`);
  let sum = 0;
  let found = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(re);
    if (!m) continue;
    const parsed = Number(m[2]);
    if (Number.isFinite(parsed)) {
      sum += parsed;
      found = true;
    }
  }
  return found ? sum : null;
}

/**
 * Parse an error-budget-consumption ratio from a Prometheus endpoint.
 * Prefers a directly-exported gauge; otherwise derives it from request/error
 * counters. Returns null when neither signal is present.
 *
 * The counter path computes the same quantity as the app's own
 * `computeErrorBudgetConsumed()`: the error rate divided by the target error
 * rate, i.e. the fraction of the error budget that has been spent. Returning
 * the raw error rate here would compare an error rate against
 * budget-consumption thresholds and be wrong by a factor of
 * 1 / targetErrorRate (2000x at the default 99.95% SLO).
 */
export function parseBudgetConsumed(text, cfg = CONFIG) {
  // Preferred: an explicit gauge exported by the metrics endpoint.
  const direct = parseMetric(text, "sse_error_budget_consumed");
  if (direct !== null) {
    // The gauge is 0..1; convert to a percentage.
    return { consumedPercent: round2(direct * 100), source: "gauge" };
  }

  // Fallback: derive from counters. Sum every series of each counter.
  const total = sumMetric(text, "sse_requests_total");
  if (total === null || total === 0) return null;

  // Prefer an explicitly-labelled error counter if the endpoint exports one.
  const errorCount =
    sumMetric(text, "sse_error_responses_total") ??
    sumMetric(text, "sse_requests_failed_total");

  if (errorCount === null) return null;

  const targetErrorRate = Number(cfg?.targetErrorRate ?? CONFIG.targetErrorRate);
  if (!Number.isFinite(targetErrorRate) || targetErrorRate <= 0) return null;

  const errorRate = errorCount / total;
  const consumed = errorRate / targetErrorRate;
  return { consumedPercent: round2(Math.min(1, consumed) * 100), source: "counters" };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Decision policy
// ---------------------------------------------------------------------------

/**
 * Pure decision function. Separated from I/O so it is directly unit-testable.
 *
 * @returns {{ decision: "allow"|"warn"|"block", exitCode: 0|1|2, reason: string }}
 */
export function decide(consumedPercent, cfg = CONFIG) {
  if (consumedPercent >= cfg.exhaustedThreshold) {
    return {
      decision: "block",
      exitCode: 1,
      reason: `error budget exhausted (${consumedPercent}% consumed, threshold ${cfg.exhaustedThreshold}%)`,
    };
  }
  if (consumedPercent >= cfg.blockedThreshold) {
    return {
      decision: "block",
      exitCode: 1,
      reason: `error budget consumption above blocked threshold (${consumedPercent}% >= ${cfg.blockedThreshold}%)`,
    };
  }
  if (consumedPercent >= cfg.warningThreshold) {
    return {
      decision: "warn",
      exitCode: 2,
      reason: `error budget consumption above warning threshold (${consumedPercent}% >= ${cfg.warningThreshold}%)`,
    };
  }
  return {
    decision: "allow",
    exitCode: 0,
    reason: `error budget consumption within limits (${consumedPercent}% < ${cfg.warningThreshold}%)`,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function buildSummary(cfg, decision, consumedPercent, extra = {}) {
  const lines = [
    "## SLO Validation Gate",
    "",
    `**Service:** ${cfg.serviceName}`,
    `**Environment:** ${cfg.environment}`,
    `**Git SHA:** ${cfg.gitSha}`,
    "",
    "---",
    "",
    `**Decision:** ${decision.decision.toUpperCase()}`,
    `**Reason:** ${decision.reason}`,
  ];

  if (consumedPercent !== null) {
    lines.push(
      `**Budget Consumed:** ${consumedPercent}%`,
      `**Remaining Budget:** ${round2(100 - consumedPercent)}%`,
    );
  } else {
    lines.push("**Budget Consumed:** unavailable", "**Remaining Budget:** unavailable");
  }

  lines.push(
    "",
    `**SLO Window:** ${cfg.windowSeconds}s (${round2(cfg.windowSeconds / 86400)} days)`,
    `**Thresholds:** warn >= ${cfg.warningThreshold}% | block >= ${cfg.blockedThreshold}% | exhausted >= ${cfg.exhaustedThreshold}%`,
  );

  if (extra.source) lines.push(`**Signal Source:** ${extra.source}`);
  if (extra.note) lines.push("", `> ${extra.note}`);

  if (decision.exitCode === 2) {
    lines.push(
      "",
      "Manual approval required. Re-run with `SLO_GATE_OVERRIDE_APPROVED=true` and an audited reason.",
    );
  }
  if (decision.exitCode === 1) {
    lines.push(
      "",
      "Deployment blocked. To override (emergency/reliability remediation only), set the repository variable `SLO_GATE_OVERRIDE_APPROVED` to `true` with `SLO_GATE_OVERRIDE_REASON` set.",
    );
  }

  lines.push("");
  return lines.join("\n");
}

function emitStructuredLog(cfg, decision, consumedPercent, extra = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    event: "slo_validation_gate",
    service: cfg.serviceName,
    environment: cfg.environment,
    gitSha: cfg.gitSha,
    actor: cfg.actor,
    decision: decision.decision,
    exitCode: decision.exitCode,
    reason: decision.reason,
    budgetConsumedPercent: consumedPercent,
    remainingBudgetPercent:
      consumedPercent === null ? null : round2(100 - consumedPercent),
    sloWindowSeconds: cfg.windowSeconds,
    thresholds: {
      warning: cfg.warningThreshold,
      blocked: cfg.blockedThreshold,
      exhausted: cfg.exhaustedThreshold,
    },
    ...extra,
  };
  console.error(`[SLO GATE] ${JSON.stringify(payload)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function fetchMetrics(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), numEnv("SLO_FETCH_TIMEOUT_MS", 8000));
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, text: null };
    }
    const text = await res.text();
    return { ok: true, error: null, text };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Evaluate a gate run against an already-fetched metrics payload.
 *
 * Pure: no I/O, no process.exit. This is the part the unit tests exercise.
 *
 * @param {object} input
 * @param {string|null} input.metricsText - raw Prometheus exposition, or null
 * @param {string|null} input.fetchError - set when the metrics fetch failed
 * @param {object} input.cfg - resolved configuration
 * @returns {{decision:"allow"|"warn"|"block", exitCode:0|1|2, reason:string,
 *            consumedPercent:number|null, override:boolean, source?:string}}
 */
export function evaluate({ metricsText = null, fetchError = null, cfg = CONFIG }) {
  // ---- Emergency override (audited) ----
  if (cfg.overrideApproved) {
    return {
      decision: "allow",
      exitCode: 0,
      reason: "emergency override approved",
      consumedPercent: null,
      override: true,
    };
  }

  // ---- Unavailable data ----
  if (fetchError) {
    return {
      decision: "block",
      exitCode: cfg.failClosed ? 1 : 0,
      reason: `SLO data unavailable (${fetchError})`,
      consumedPercent: null,
      override: false,
    };
  }

  // ---- Malformed data ----
  let parsed = null;
  let parseError = null;
  try {
    parsed = parseBudgetConsumed(metricsText, cfg);
    if (!parsed) parseError = "no error-budget metric found in response";
  } catch (err) {
    parseError = err?.message || "parse failure";
  }

  if (parseError) {
    return {
      decision: "block",
      exitCode: cfg.failClosed ? 1 : 0,
      reason: `SLO data malformed (${parseError})`,
      consumedPercent: null,
      override: false,
    };
  }

  // ---- Sample age ----
  //
  // The counters behind the metric are held in the service process, so they
  // only cover the time since the last restart. A sample that does not span
  // the SLO window cannot say anything about the budget over that window, and
  // reading it as if it could would silently allow exactly the deployments
  // the gate exists to catch (a crash-looping service has just reset its
  // counters). The exporter publishes the sample age so this is checkable.
  const sampleAge = parseMetric(metricsText, "sse_metrics_sample_age_seconds");
  if (cfg.requireFullWindow && sampleAge !== null && sampleAge < cfg.windowSeconds) {
    return {
      decision: "block",
      exitCode: cfg.failClosed ? 1 : 0,
      reason:
        `SLO sample covers only ${Math.round(sampleAge)}s of the ${cfg.windowSeconds}s window — ` +
        "the service has not been up long enough for the metric to represent the SLO window",
      consumedPercent: parsed.consumedPercent,
      override: false,
      source: parsed.source,
    };
  }

  // ---- Decide ----
  const decision = decide(parsed.consumedPercent, cfg);
  return {
    ...decision,
    consumedPercent: parsed.consumedPercent,
    override: false,
    source: parsed.source,
  };
}

export async function main() {
  const cfg = CONFIG;

  // ---- Explicit skip ----
  //
  // SLO_GATE_SKIP is honoured here as well as in the workflow step, so the
  // documented skip works no matter which path invokes the script. It is
  // never silent: the decision is logged and printed as a warning.
  if (cfg.skip) {
    const decision = {
      decision: "allow",
      exitCode: 0,
      reason: "SLO gate skipped via SLO_GATE_SKIP",
    };
    emitStructuredLog(cfg, decision, null, { skipped: true });
    console.error(
      buildSummary(cfg, decision, null, {
        note:
          "**SLO GATE SKIPPED** (SLO_GATE_SKIP=true). This deploy was NOT validated " +
          "against the error budget.",
      }),
    );
    process.exit(0);
  }

  // ---- Emergency override (audited) ----
  //
  // The override is checked first: it is an explicit, audited approval to
  // deploy, so it must win even when the metrics endpoint is misconfigured.
  if (cfg.overrideApproved) {
    emitStructuredLog(cfg, { decision: "allow", exitCode: 0, reason: "emergency override approved" }, null, {
      override: true,
      overrideReason: cfg.overrideReason,
    });
    console.error(
      buildSummary(
        cfg,
        { decision: "allow", exitCode: 0, reason: "emergency override approved" },
        null,
        {
          note: `**OVERRIDE USED** by \`${cfg.actor}\` at ${new Date().toISOString()} — reason: ${cfg.overrideReason}`,
        },
      ),
    );
    process.exit(0);
  }

  // ---- Resolve endpoint ----
  //
  // There is deliberately NO localhost fallback. On a CI runner
  // `http://localhost:3000/metrics` measures the runner, not the service, so
  // it would silently report a healthy budget and wave through every deploy.
  // An unset endpoint is a configuration error and fails closed.
  if (!cfg.metricsEndpoint) {
    // A gate with no endpoint cannot say anything about the error budget, so
    // it blocks — including when SLO_FAIL_CLOSED=false, because a
    // misconfigured gate is a configuration error, not a data problem. The
    // explicit releases are SLO_GATE_SKIP and the audited override above.
    const decision = {
      decision: "block",
      exitCode: 1,
      reason: "SLO_METRICS_ENDPOINT is not configured",
    };
    emitStructuredLog(cfg, decision, null, { missingEndpoint: true });
    console.error(
      buildSummary(cfg, decision, null, {
        note:
          "SLO_METRICS_ENDPOINT is not set. The gate refuses to fall back to a " +
          "local endpoint because a CI-runner localhost would measure the runner, " +
          "not the service. Set SLO_METRICS_ENDPOINT to the authoritative metrics URL.",
      }),
    );
    process.exit(1);
  }

  const endpoint = cfg.metricsEndpoint;

  // ---- Fetch ----
  let metricsText = null;
  let fetchError = null;
  try {
    const result = await fetchMetrics(endpoint);
    if (!result.ok) {
      fetchError = result.error;
    } else {
      metricsText = result.text;
    }
  } catch (err) {
    fetchError = err?.name === "AbortError" ? "request timed out" : err?.message || "unknown error";
  }

  const outcome = evaluate({ metricsText, fetchError, cfg });

  if (fetchError) {
    emitStructuredLog(cfg, outcome, null, { fetchError, endpoint });
    console.error(buildSummary(cfg, outcome, null, { note: `Failed to fetch ${endpoint}: ${fetchError}` }));
    process.exit(outcome.exitCode);
  }

  if (outcome.consumedPercent === null) {
    emitStructuredLog(cfg, outcome, null, { parseError: outcome.reason, endpoint });
    console.error(buildSummary(cfg, outcome, null, { note: outcome.reason }));
    process.exit(outcome.exitCode);
  }

  emitStructuredLog(cfg, outcome, outcome.consumedPercent, { source: outcome.source, endpoint });
  console.error(buildSummary(cfg, outcome, outcome.consumedPercent, { source: outcome.source }));
  process.exit(outcome.exitCode);
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("validate-slo.mjs")) {
  main().catch((err) => {
    console.error("[SLO GATE] Unhandled error:", err?.message || err);
    process.exit(1);
  });
}
