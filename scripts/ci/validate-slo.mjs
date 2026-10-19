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
 * All thresholds are environment-configurable; see
 * `PRODUCTION_READINESS_CONTROLS.md` (section "SLO Validation Gate") for the
 * full variable table, the window semantics and the rollback procedure.
 *
 * Security: this script only reads metrics. It never logs secrets, request
 * bodies, or user data.
 */

import { isIP } from "node:net";

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
  // SLO window cannot say anything about the budget over that window.
  //
  // This is REPORTED, not enforced, by default. A deploy restarts the
  // service, so the sample age at gate time is seconds old — a check that
  // blocked on it would block every deploy and the gate would never pass
  // once. It is enforced only when the operator asks for it:
  //
  //   SLO_REQUIRE_FULL_WINDOW=true -> block when the sample does not span
  //     the window. Meaningful only when the endpoint is a time-series store
  //     that outlives a single process lifetime.
  //   SLO_MIN_SAMPLE_SECONDS > 0   -> block when the sample is thinner than
  //     the given number of seconds.
  //
  // Either way the age is included in the decision reason, so a reader of
  // the job summary always sees how much of the window the figure covers.
  requireFullWindow: (process.env.SLO_REQUIRE_FULL_WINDOW || "false") !== "false",
  minSampleSeconds: numEnv("SLO_MIN_SAMPLE_SECONDS", 0),

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
  //
  // The metric names and the formula are the ones the application's own
  // registry uses (see computeErrorBudgetConsumed in
  // src/sse/services/metrics.js): total requests, error responses, error
  // rate, divided by the target error rate, capped at 1.
  const total = sumMetric(text, "sse_requests_total");
  if (total === null || total === 0) return null;

  const errorCount = sumMetric(text, "sse_error_responses_total");
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

// ---------------------------------------------------------------------------
// Loopback refusal
// ---------------------------------------------------------------------------

/**
 * Expand an IPv6 address into its eight 16-bit groups.
 *
 * `URL` normalises IPv6 into the compressed hex form, so `::ffff:127.0.0.1`
 * arrives as `::ffff:7f00:1` and cannot be compared as a dotted quad.
 *
 * @param {string} host - an IPv6 address without brackets
 * @returns {number[]} eight groups, or [] when the address is malformed
 */
export function expandIPv6(host) {
  const parts = host.split("::");
  let groups;
  if (parts.length === 1) {
    groups = parts[0].split(":");
  } else {
    const head = parts[0] ? parts[0].split(":") : [];
    const tail = parts[1] ? parts[1].split(":") : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return [];
    groups = [...head, ...new Array(fill).fill("0"), ...tail];
  }
  if (groups.length !== 8) return [];
  const out = groups.map((g) => parseInt(g, 16));
  return out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? out : [];
}

/**
 * True when the endpoint's host is a loopback address.
 *
 * The gate must never read a loopback endpoint. On a CI runner,
 * `http://localhost:3000/metrics` measures the runner rather than the
 * service, so it reports a healthy error budget and waves every deploy
 * through — silently, because the summary looks exactly like a healthy
 * service.
 *
 * The check is on the PARSED host, not on the raw string, because the raw
 * string has many spellings of the same address and because parsing is the
 * only thing that gets the inverse case right: `http://localhost@real.host/`
 * has the host `real.host`, and a substring match on "localhost" would
 * refuse a perfectly good endpoint.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isLoopbackEndpoint(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    // An unparseable URL is not a loopback address; it fails closed in the
    // fetch path instead, where the error is reported as a fetch failure.
    return false;
  }

  // RFC 6761 reserves `localhost` and everything under `.localhost` for the
  // loopback interface.
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;

  // `URL` keeps the brackets on an IPv6 host.
  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  if (isIP(bare) === 4) {
    // The parser normalises every spelling of 127.0.0.1 to the dotted quad
    // (127.1, 2130706433, 0x7f000001 and 0177.0.0.1 all become 127.0.0.1).
    // 0.0.0.0 is the unspecified address and routes to loopback.
    return bare === "0.0.0.0" || bare.startsWith("127.");
  }

  if (isIP(bare) === 6) {
    const g = expandIPv6(bare);
    if (g.length !== 8) return false;
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible addresses.
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
      if (g[6] === 0x7f00) return true; // ::ffff:127.0.0.0/8
      if (g[6] === 0 && g[7] === 0) return true; // ::ffff:0.0.0.0
    }
    return false;
  }

  return false;
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
      decision: cfg.failClosed ? "block" : "warn",
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
      decision: cfg.failClosed ? "block" : "warn",
      exitCode: cfg.failClosed ? 1 : 0,
      reason: `SLO data malformed (${parseError})`,
      consumedPercent: null,
      override: false,
    };
  }

  // ---- Sample age ----
  //
  // The counters behind the metric are held in the service process, so they
  // only cover the time since the last restart. The age is reported in the
  // reason so a reader always knows how much of the window the figure
  // covers, and it is only ENFORCED when the operator asked for it — a
  // deploy restarts the service, so the age at gate time is seconds old
  // and an enforcing check would block every deploy.
  const sampleAge = parseMetric(metricsText, "sse_metrics_sample_age_seconds");
  const ageUnknown = sampleAge === null;
  const sampleAgeNote = ageUnknown
    ? "sample age unknown (the endpoint does not publish sse_metrics_sample_age_seconds)"
    : `sample covers ${Math.round(sampleAge)}s of the ${cfg.windowSeconds}s window`;

  // An explicitly-enabled check must not be silently bypassed by an
  // endpoint that does not publish the age gauge. The operator turned the
  // check ON; an endpoint that cannot answer the question is not a pass,
  // it is an unknown. (With the checks off — the default — an unknown age
  // is reported and nothing else changes.)
  if (cfg.minSampleSeconds > 0 && (ageUnknown || sampleAge < cfg.minSampleSeconds)) {
    return {
      decision: cfg.failClosed ? "block" : "warn",
      exitCode: cfg.failClosed ? 1 : 0,
      reason: ageUnknown
        ? `SLO sample age is unknown — the required minimum of ${cfg.minSampleSeconds}s ` +
          "cannot be verified (the endpoint does not publish sse_metrics_sample_age_seconds)"
        : `SLO sample covers only ${Math.round(sampleAge)}s, below the required minimum of ` +
          `${cfg.minSampleSeconds}s — the metric has too little data to judge`,
      consumedPercent: parsed.consumedPercent,
      override: false,
      source: parsed.source,
    };
  }

  if (cfg.requireFullWindow && (ageUnknown || sampleAge < cfg.windowSeconds)) {
    return {
      decision: cfg.failClosed ? "block" : "warn",
      exitCode: cfg.failClosed ? 1 : 0,
      reason: ageUnknown
        ? "SLO sample age is unknown — the sample cannot be shown to span the " +
          `${cfg.windowSeconds}s window (the endpoint does not publish sse_metrics_sample_age_seconds)`
        : `SLO sample covers only ${Math.round(sampleAge)}s of the ${cfg.windowSeconds}s window — ` +
          "the sample has to span the whole SLO window (SLO_REQUIRE_FULL_WINDOW=true)",
      consumedPercent: parsed.consumedPercent,
      override: false,
      source: parsed.source,
    };
  }

  // ---- Decide ----
  const decision = decide(parsed.consumedPercent, cfg);
  return {
    ...decision,
    reason: `${decision.reason} (${sampleAgeNote})`,
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

  // ---- Refuse a loopback endpoint ----
  //
  // The requirement is absolute: the gate must NEVER read a loopback
  // endpoint. On a CI runner `http://localhost:3000/metrics` measures the
  // runner, not the service, so it reports a healthy error budget and waves
  // every deploy through — silently, because the summary of a healthy runner
  // is indistinguishable from the summary of a healthy service.
  //
  // The check above refuses an UNSET endpoint. This one refuses a SET but
  // loopback endpoint. Both are needed, and neither substitutes for the
  // other: an unset endpoint is a configuration error, a loopback endpoint is
  // a measurement of the wrong thing.
  //
  // The refusal is unconditional. There is no flag for it: a gate that has
  // been told to read the runner's own metrics cannot tell a healthy runner
  // from a healthy service, so no setting makes that safe. The release paths
  // remain SLO_GATE_SKIP and the audited SLO_GATE_OVERRIDE_APPROVED, and
  // neither of them queries anything — the override exits before this point.
  if (isLoopbackEndpoint(endpoint)) {
    const decision = {
      decision: "block",
      exitCode: 1,
      reason: "SLO_METRICS_ENDPOINT points at a loopback address",
    };
    emitStructuredLog(cfg, decision, null, { loopbackEndpoint: true, endpoint });
    console.error(
      buildSummary(cfg, decision, null, {
        note:
          "SLO_METRICS_ENDPOINT points at a loopback address (" +
          endpoint +
          "). A loopback endpoint measures the CI runner, not the deployed " +
          "service, so the gate would report a healthy error budget and " +
          "allow a deploy that was never validated. Point " +
          "SLO_METRICS_ENDPOINT at the deployed service's metrics URL, or at " +
          "the authoritative Prometheus.",
      }),
    );
    process.exit(1);
  }

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
