# SRE ADR: Error Handling, Observability, and Reliability Strategy

## ADR Status: DRAFT
**Date:** 2026-10-19
**Author:** SRE Subagent

---

## 1. Error Handling Strategy

### 1.1 Fail-Closed vs Fail-Open Assessment

**Current State: FAIL-CLOSED with controlled fallbacks**

The system is predominantly **fail-closed** — when errors occur, the system either:
- Returns specific error responses to the client (400, 401, 429, 502, 503)
- Automatically falls back to alternative accounts/models within a combo
- Retries with token refresh on auth errors

**Fail-Closed behaviors (intentional):**
- Invalid JSON body → 400 Bad Request (src/sse/handlers/tts.js:27, chat.js:41)
- Missing API key → 401 Unauthorized (tts.js:40, chat.js:76)
- Missing model → 400 Bad Request (tts.js:45, chat.js:87)
- Invalid model format → 400 Bad Request (stt.js:61, chat.js:230)
- Provider execution failure → error response with upstream error details (chatCore.js:433)
- All combo models exhausted → 503 Service Unavailable (combo.js:426)

**Fail-Open behaviors (risk areas):**
- RTK (Request Token Killer) + headroom.js: documented as "fail-open" — any error returns null and leaves body untouched (open-sse AGENTS.md Pitfalls)
- PXPIPE image compression: errors don't break the request (rtk/pxpipe.js)
- Caveman/ponytail system prompts: errors don't propagate (rtk/caveman.js, rtk/ponytail.js)
- NoAuth free providers: if proxy pool fails, falls back to direct connection (auth.js:51-57)

**Risk:** Fail-open components could silently pass corrupted data downstream. Must monitor for data integrity issues.

### 1.2 Error Handling Patterns by Component

| Component | Error Path | Recovery Strategy |
|-----------|-----------|-------------------|
| **TTS Core** | `handleTtsCore` catch → `createErrorResult(502, err.message)` | Direct error response; no retry within TTS |
| **Provider Credentials** | `getProviderCredentials` → filter → return null/{allRateLimited} | Fallback to next account in loop; mark unavailable on failure |
| **Combo Fallback** | `handleComboChat` loop over models | Progressive fallback; track `lastError`/`lastStatus`; 503 if all fail |
| **Fusion Combo** | `handleFusionChat` parallel panel + judge | Degrade gracefully: 0 answers → 503, 1 answer → direct response |
| **Chat Core** | `handleChatCore` try/catch around executor.execute() | Token refresh on 401/403; parse upstream error; return error result |
| **SSE Streaming** | `handleStreamingResponse` errors | `streamController.handleError()`; track pending request as failed |

### 1.3 Error Budget Philosophy

- **Error budget**: Implicit through SLO targets (see SLO/SLI section)
- **Burn rate**: Monitored through `getUsageStats` error rates and `lastErrorProvider` tracking
- **Automation over heroics**: All error paths have automated fallback logic; manual intervention only on sustained budget consumption

---

## 2. Observability Goals and Current State

### 2.1 The Three Pillars

#### Metrics (Currently Available)
- **Pending requests**: `global._pendingRequests.byModel`, `byAccount` (in-memory, capped)
- **Usage stats**: `getUsageStats()` — total requests, per-provider/model/account breakdowns, cost, tokens
- **Error provider tracking**: `global._lastErrorProvider` — last provider with error, timestamp (10s window)
- **Recent ring buffer**: 50 most recent usage entries via `getRecentLogs()`
- **Active requests**: `getActiveRequests()` — currently running per model/provider/account

**Gaps:** No Prometheus-compatible metrics endpoint. All metrics are in-memory or SQLite-backed ad-hoc queries.

#### Logs (Currently Available)
- **Console capture**: `initConsoleLogCapture()` patches console methods
- **Colored session tags**: 🟢🔵🟣🟡🟠🔴⚪🟤 rotating per session
- **Request lines**: `[timestamp] 📥 POST /path` (logger.js:97)
- **Response lines**: `[timestamp] 📤 200 (1234ms)` or `[timestamp] 💥 500 (567ms)` (logger.js:102-106)
- **Stream lines**: `[timestamp] 🌊 [STREAM] event` (logger.js:108-111)
- **Tagged logs**: `[timestamp] tag symbol message` — e.g., `[ℹ️] [CHAT] ...` (logger.js:76-81)
- **Error always visible**: `errorLine()` bypasses log level filter (logger.js:42-44)

**Structured data in logs:**
- Error objects: `formatData` → JSON string (logger.js:59-67)
- API key masking: `maskKey()` → `****...****` (logger.js:114-117)
- Thinking budget: `fmtThink()` → `"10k"` or `"auto"` (logger.js:47-57)

#### Traces (Currently Available — Limited)
- Request ID correlation via `sessionSeed` → `reqTag` (chatCore.js:67-74)
- Unified "▶" log line with format, thinking, account, tool counts (chatCore.js:243-261)
- "⚙" token saver summary line (chatCore.js:324)
- Pending request tracking with completion/failure (usageDb.js:154-196)

**Gaps:** No distributed tracing (OpenTelemetry, Jaeger, etc.). No request-level latency metrics collected systematically.

### 2.2 Golden Signals — Current Coverage

| Signal | Status | Coverage |
|--------|--------|----------|
| **Latency** | Partial | Response time lines in console, but no aggregated latency metrics |
| **Traffic** | Good | `getUsageStats()` → totalRequests, per-endpoint counts; recent ring buffer |
| **Errors** | Good | `lastErrorProvider`, usage DB status fields, error log lines |
| **Saturation** | Limited | Pending request counts (`_pendingRequests.byModel`), active account tracking |

### 2.3 Current Observability Stack

```
Console Log Capture
  │
  └─ patches console.log/info/warn/error/debug
          │
          ├─ Colored session tags (🟢🔵🟣...)
          ├─ Request/response lines with timing
          ├─ Stream event lines
          └─ Tagged structured logs [timestamp] tag symbol message

Usage DB (SQLite)
  │
  ├─ usageHistory (per-request detail)
  ├─ usageDaily (denormalized daily summaries)
  ├─ totalRequestsLifetime counter
  └─ byProvider/Model/Account/ApiKey/Endpoint breakdowns

In-Memory State
  │
  ├─ _pendingRequests (pending request counts)
  ├─ _lastErrorProvider (last error source)
  ├─ _recentRing (50-entry ring buffer)
  └─ _statsEmitTimers (debounced stats events)

Structured JSON Logs (added by this branch)
  │
  ├─ one line per event, JSON, on stdout
  ├─ sse_state_* (persistence lifecycle and every failure path)
  ├─ sse_circuit_breaker_{open,half_open,closed} (every state transition)
  └─ sse_metrics_dropped_series_total (the registry at its ceiling)

Metrics Registry (added by this branch, in-process)
  │
  ├─ sse_requests_total / sse_error_responses_total
  ├─ sse_request_latency_seconds (fixed buckets)
  ├─ sse_error_budget_consumed (gauge — the signal the SLO gate reads)
  ├─ sse_circuit_breaker_state (gauge) + sse_circuit_breaker_transitions_total
  ├─ sse_circuit_breaker_rejections_total (refused by an open circuit —
  │   part of the error count, so a total outage behind an open circuit
  │   consumes the budget instead of reading as a perfect one)
  └─ sse_metrics_sample_age_seconds (the gate can tell a fresh process from a stale one)
```

### 2.4 Recommended Observability Additions

1. **Structured JSON logs** with request ID, model, provider, status, latency
2. **Prometheus metrics endpoint** (`/metrics` or `/api/metrics`):
   - `sse_requests_total` (count, by status, by provider, by endpoint)
   - `sse_request_latency_seconds` (histogram: p50, p95, p99)
   - `sse_error_budget_consumed` (gauge 0-1, derived from error rates)
   - `sse_circuit_breaker_state` (gauge) and
     `sse_circuit_breaker_transitions_total` (counter, by provider and by the
     state it moved to) — the gauge is the state at scrape time, the counter
     is the event; a breaker that opens and closes silently cannot be audited
   - `sse_metrics_sample_age_seconds` (gauge) and
     `sse_metrics_dropped_series_total` (counter) — the first tells the SLO
     gate whether the sample spans the window, the second says the registry
     hit its ceiling
   - *not implemented:* `sse_pending_requests` (gauge by model/provider) and
     `sse_active_accounts` (gauge by provider) — the pending-request figure is
     reported by `/api/health` instead of as a gauge
3. **Distributed tracing** (OpenTelemetry) for request pipeline
4. **SLO dashboard** with error budget tracking
5. **Alert on error rate spikes** (>5% of requests, or >2x baseline)

#### Implemented: structured logs, metrics endpoint, health endpoint

> **Status: implemented.** See `PRODUCTION_READINESS_CONTROLS.md` for the full
> specification and rollback guidance.

- **Structured JSON logs** — `src/sse/utils/logger.js` gained additive
  `structured`, `structuredDebug`, `structuredInfo`, `structuredWarn` and
  `structuredError` exports. The existing logger API is untouched.
- **Prometheus metrics endpoint** — `GET /api/metrics` exports
  `sse_requests_total`, `sse_error_responses_total`,
  `sse_request_latency_seconds` (a fixed-bucket histogram, so memory is
  bounded regardless of traffic), `sse_error_budget_consumed`,
  `sse_circuit_breaker_state`, `sse_circuit_breaker_transitions_total`,
  `sse_circuit_breaker_rejections_total` and
  `sse_metrics_sample_age_seconds`.
- **Health endpoint** — `GET /api/health` reports pending request counts,
  active connections, requests dropped by the last restart, the remaining
  error budget, the last error provider, per-provider circuit-breaker state
  and process uptime. It exposes no request payloads, credentials, or user
  data, and keeps the original `ok: true` field and CORS headers that the
  dashboard's cross-origin endpoint ping depends on.

The error-budget figure in the health view is derived from the same counters
the SLO gate reads, so the two can never disagree.

#### Implemented: graceful-restart state persistence

> **Status: implemented.** See `PRODUCTION_READINESS_CONTROLS.md` for the full
> specification and rollback guidance.

The in-memory state listed above (`_pendingRequests`, `_lastErrorProvider`,
`_recentRing`) is lost on a restart. `src/sse/services/state-persistence.js`
now persists a small, non-sensitive slice of it so a graceful restart does
not lose the operational picture.

| Persisted | Never persisted |
|-----------|-----------------|
| Request counters (by model / account) | API keys, tokens, cookies, secrets |
| Last error provider | Prompt / completion text, request bodies |
| Optional sanitised ring buffer | Raw HTTP headers, PII |
| `persistedAt`, `uptimeSeconds` | Sockets, streams, timers, connection objects |

The sanitiser is an **allow-list**, not a deny-list: only explicitly
permitted fields are written. The ring-buffer entries carry an `apiKey`
field; it is not in the allow-list, so it is dropped even when ring
persistence is enabled. The ring buffer is off by default because
`usageRepo` already rehydrates it from SQLite.

Writes are atomic (temp file → `fsync` → `rename`), so a crash mid-write
leaves either the previous complete file or the new complete file. The
periodic snapshot is asynchronous; the shutdown write is deliberately
**synchronous**, because the app's own shutdown handler calls `process.exit()`
and would otherwise kill an in-flight async write mid-file. Nothing in the
module runs on the request path.

---

## 3. Drift Prevention for Production Incidents

### 3.1 Current Drift Prevention Mechanisms

| Mechanism | How It Works | Effectiveness |
|-----------|-------------|---------------|
| **modelLock_* DB keys** | `markAccountUnavailable` locks failed accounts/models; `clearAccountError` clears on success | ✅ High — prevents repeated failures to same account |
| **Sticky round-robin limit** | `consecutiveUseCount` per account, reset on success or after limit (auth.js:158-196) | ✅ High — prevents account starvation |
| **Antigravity quota cache** | Lazy-loaded per-model quota; skip exhausted accounts until resetAt (auth.js:83-101) | ✅ High — prevents cascading quota exhaustion |
| **Error rules text matching** | `ERROR_RULES` in errorConfig.js — text/status-based cooldown assignment | ✅ Medium — could misclassify new error types |
| **Combo auto-switch** | `detectRequiredCapabilities` → `reorderByCapabilities` → front-load vision/pdf models (combo.js:326-333) | ✅ Medium — prevents vision requests on non-vision models |
| **Fusion quorum grace** | `collectPanel` with `minPanel` + `stragglerGraceMs` + `panelHardTimeoutMs` (combo.js:553-580) | ✅ Medium — caps straggler penalty but could timeout |

### 3.2 Drift Prevention Gaps

1. **No circuit breaker** for consistently failing providers — fallback depends on accounts being marked unavailable, but there's no global "circuit break" threshold
2. **No request-level latency SLO** tracked in metrics — only console logs with timing
3. **No health check endpoint** to verify SSE handler availability
4. **In-memory state volatility** — `_pendingRequests`, `_lastErrorProvider`, `_recentRing` reset on process restart
5. **No deployment-time SLO validation** — SLOs are documented but not enforced at deploy time

### 3.3 Recommended Drift Prevention

1. **Circuit breaker pattern** per provider: after N consecutive failures, mark provider "closed" for configurable window
2. **Health check endpoint** `/api/health` or `/v1/health` returning:
   - SSE handler status
   - Pending request count
   - Error budget remaining
   - Active account count per provider
3. **Process-level metrics persistence** — save `_pendingRequests` et al. to DB on shutdown
4. **SLO gate in deployment pipeline** — fail deployment if error budget would be exceeded
5. **Error rule audit** — quarterly review of `ERROR_RULES` against actual error patterns

> Items 1, 2, 3 and 4 are implemented by this branch. The breaker's state
> changes are announced — a structured log line and
> `sse_circuit_breaker_transitions_total` — because a breaker that opens and
> closes silently is a control that cannot be audited; the state gauge is a
> snapshot of a moment and cannot say when the circuit opened or whether the
> provider has been flapping.
>
> Item 5 is not addressed by this branch.
>
> **The drift check's own limit.** The gate compares the *sets* of failing
> tests between the base commit and the change, so it detects a test that
> failed on the change and passed on the base. A test that fails on **both**
> sides is not attributed to the change — and a change that *alters* an
> already-broken test therefore leaves the failing set unchanged. That is not
> hypothetical: a golden snapshot committed with machine-dependent values was
> red on every Linux runner while the gate reported green, because the base
> had no snapshot and failed the same cases. The snapshot is portable now, a
> guard test keeps it that way, and the gate **reports** the failures it
> cannot attribute, calling out the ones in files the change touched.

---

## 4. Alert Thresholds and Guardrails

### 4.1 Proposed Alert Rules

| Severity | Condition | Action | Delay |
|----------|-----------|--------|-------|
| **critical** | Error rate > 5% in last 5 minutes **OR** error budget < 10% remaining | Page on-call, block deployments | Immediate |
| **warning** | Error rate > 2% in last 30 minutes **OR** error budget < 25% remaining | Notify on-call, investigate | 5 minutes |
| **info** | Pending requests > 100 **OR** active accounts < 2 for any provider | Dashboard alert, review during next deploy | 15 minutes |
| **info** | Stream stall > 60s (no chunks received) | Investigate executor/upstream | 1 minute |

### 4.2 Guardrails

| Guardrail | Current Status | Recommendation |
|-----------|---------------|----------------|
| **Max retry attempts** | `DEFAULT_RETRY_CONFIG`: 429→0 attempts, 502→3@3s, 503→2@2s, 504→2@3s (runtimeConfig.js:78-83) | Add config-driven override via env vars |
| **Token refresh attempts** | `refreshWithRetry(3, log)` — max 3 attempts (chatCore.js:443) | Make configurable; add exponential backoff |
| **Combo model attempts** | `handleComboChat` iterates all models, no hard cap beyond available models | Add max retry per model to prevent infinite loops |
| **Fusion timeout** | `panelHardTimeoutMs: 90000` (combo.js:533) | Make configurable; add metrics on timeout frequency |
| **Stream stall timeout** | `STREAM_STALL_TIMEOUT_MS: 360000` (runtimeConfig.js:53) | Already config via env; monitor usage |
| **Fetch connect timeout** | `FETCH_CONNECT_TIMEOUT_MS: 60000` (runtimeConfig.js:59) | Already config via env; add alert on frequent timeouts |

### 4.3 SLO-Driven Guardrails

- **Ship features** when error budget > 0 remaining
- **Freeze deploys** when error budget < 10% remaining
- **Rollback** when error budget < 5% remaining for > 15 minutes
- **Canary deployments** with SLO monitoring before full rollout (per SRE best practices)

#### Implemented: the SLO validation gate

> **Status: implemented.** See `PRODUCTION_READINESS_CONTROLS.md` for the full
> specification, configuration and rollback guidance.

The deploy-time gate lives in `scripts/ci/validate-slo.mjs` and runs as the
`slo-validation-gate` job in `.github/workflows/drift-prevention.yml`, before
any production deploy.

| Budget consumed | Decision | Exit code |
|---|---|---|
| `< 50%` | allow | `0` |
| `50% – 75%` | warn (manual approval) | `2` |
| `75% – 95%` | block | `1` |
| `>= 95%` | block (exhausted) | `1` |
| missing / malformed / unavailable data | block (fail-closed) | `1` |

The gate reads the `sse_error_budget_consumed` gauge exported by
`GET /api/metrics` (falling back to the request/error counters), and refuses
a CI-runner `localhost` endpoint — an unset `SLO_METRICS_ENDPOINT` is a
configuration error and fails closed, and a *loopback* endpoint is refused
outright, before any request is made, because it would measure the runner
rather than the service. The refusal covers every spelling of the address,
and it is applied to **every redirect hop** as well as to the configured
endpoint: the default `redirect: "follow"` would otherwise let the server
being contacted hand the gate a `302` to the runner's own metrics. Only
`http` and `https` endpoints are read. An audited emergency override
(`SLO_GATE_OVERRIDE_APPROVED=true` plus a reason) is the only way to deploy
over a block; the actor, timestamp, reason and git SHA are logged. The gate
can be run on demand with `gh workflow run drift-prevention.yml -f
slo_gate=true -f reason="..."`, so its behaviour is observable rather than a
matter of opinion.

---

## 5. SLO/SLI Definitions

### 5.1 Proposed SLOs

| SLO | SLI | Target | Window | Burn Rate Alerts |
|-----|-----|--------|--------|-----------------|
| **Availability** | `count(status < 500) / count(total)` | 99.95% | 30d | • Critical: short window 5m, factor 14.4 • Warning: short window 30m, factor 6 |
| **Latency (p99)** | `count(duration < 300ms) / count(total)` | 99% | 30d | • Critical: short window 5m, factor 14.4 • Warning: short window 30m, factor 6 |
| **Successful TTS** | `count(TTS success) / count(TTS requests)` | 99.9% | 30d | Same burn rate pattern |
| **Chat success** | `count(chat completion ok) / count(chat requests)` | 99.8% | 30d | Same burn rate pattern |
| **Stream continuity** | `count(stream completes ok) / count(stream requests)` | 99.5% | 30d | Same burn rate pattern |

### 5.2 Current SLI Implementation Status

| SLI | Current Implementation | Gap |
|-----|----------------------|-----|
| Request count/total | `getUsageStats().totalRequests` ✅ | None |
| Error count by status | `getUsageStats().byProvider` has status, but not aggregated 5xx rate | Need aggregated error rate |
| Latency distribution | Console log lines only, no histogram | Need p99/p95 latency metrics |
| TTS success rate | Not explicitly tracked | Need TTS-specific SLI |
| Chat completion success | Not explicitly tracked | Need chat-specific SLI |
| Stream completion | Not explicitly tracked | Need stream-specific SLI |

### 5.3 Recommended SLI Implementation

```javascript
// Example: Add to usageDb.js or new metrics module

// Request duration histogram (prometheus-like)
export function observeRequestDuration(provider, model, durationMs) {
  // TODO: integrate with prometheus client or time-series DB
}

// Request success/failure
export function recordRequestResult(provider, model, status, success) {
  // TODO: record to usageHistory or new metrics table
}

// Error budget tracking
export function errorBudgetConsumed(errorRate, windowDays = 30) {
  // Calculate fraction of error budget consumed
  const baselineRate = 0.0005; // for 99.95% availability
  return errorRate / baselineRate;
}
```

---

## 6. Chaos Engineering Readiness

### 6.1 Current Failure Injection Points

| Injection Point | Method | Current Safeguard |
|----------------|--------|-------------------|
| **Provider account exhaustion** | `markAccountUnavailable` + cooldown | ✅ Controlled via DB locks |
| **Transient 503/502 errors** | `DEFAULT_RETRY_CONFIG` + token refresh | ✅ Retry with backoff |
| **Concurrent request surge** | Load testing, no explicit limit | ⚠️ Pending request gauge available |
| **Model routing failure** | Combo fallback loop | ✅ Progressive fallback to next model |
| **Translator pipeline break** | Corrupt request body | ⚠️ RTK/headroom fail-open — could pass bad data |
| **Executor timeout** | `STREAM_STALL_TIMEOUT_MS: 360s` | ✅ Configurable timeout |
| **API key revocation** | `isValidApiKey` check | ✅ Early validation on each request |

### 6.2 Recommended Chaos Experiments

1. **Account kill switch**: Temporarily mark all accounts for a provider as unavailable; verify fallback to next provider or graceful 503
2. **Latency spike**: Inject 5s delay in executor; verify stream stall timeout and error handling
3. **Translator corruption**: Send malformed request bodies; verify RTK fail-open behavior (null return, body untouched)
4. **Provider timeout**: Block upstream for 30s; verify circuit breaker / fallback behavior
5. **Combo model exhaustion**: Deplete all models in a combo; verify 503 with retryAfter
6. **Fusion judge timeout**: Hang judge model; verify stragglerGraceMs + hardTimeout behavior

#### Implemented: the chaos suite

> **Status: implemented.** See `PRODUCTION_READINESS_CONTROLS.md` for the full
> specification and rollback guidance.

All six experiments above are now automated in
`tests/chaos/provider-failures.test.js`. Failures are injected
through the existing dependency-injection seams (`handleSingleModel`,
`getCircuitBreaker`, the RTK entry points) rather than by contacting a live
upstream, so the suite is deterministic, needs no credentials, and makes no
network calls.

```bash
# The chaos suite is excluded from the default run
npm run test:chaos
```

CI: `.github/workflows/chaos-engineering.yml` runs it on `workflow_dispatch`
and on a weekly schedule.

Writing the suite against the production code — rather than against a mock of
it — surfaced several real defects, all of which are now fixed: two hard
`SyntaxError`s in `auth.js` (importing non-existent named exports), a
mis-scoped circuit-breaker success recording, a `resetAllCircuitBreakers()`
that silently ignored a new config, an unbounded fusion **judge** call, and a
combo that read the retry hint from the wrong place (the JSON body instead of
the `retry-after` header), which made the exhausted-combo retry path
unreachable.

### 6.3 Chaos Tooling Recommendations

- Use **LitmusChaos** or **PowerfulSe** for Kubernetes (if deployed there)
- For this Node.js deployment: scripted failure injection via API calls
- Measure: MTTR (mean time to recovery), fallback success rate, error budget impact

---

## 7. Incident Response Patterns

### 7.1 Incident Severity Mapping (SLO-Based)

| Severity | SLO Impact | Example | Response Time |
|----------|-----------|---------|---------------|
| **S1** | Error budget < 10% consumed in < 1h | Widespread 5xx, availability dropping fast | 15 minutes |
| **S2** | Error budget < 25% consumed in < 6h | Provider widespread failures, degraded latency | 30 minutes |
| **S3** | Error budget < 50% consumed in < 24h | Single provider degraded, intermittent errors | 2 hours |
| **S4** | cosmetic/edge cases | UI glitches, non-critical endpoint errors | Next deploy |

### 7.2 Incident Response Workflow

1. **Detection** → Alert triggers (error rate spike, error budget breach)
2. **Triage** → Check `lastErrorProvider`, `getUsageStats()`, `getActiveRequests()`
3. **Assessment** → Is this:
   - Single provider issue → exclude accounts, wait cooldown
   - Broad provider issue → check error rules, consider circuit breaker
   - Translator/executor issue → check recent logs, RTK/headroom status
   - Deployment-related → check recent deploys, rollback if needed
4. **Action** →:
   - Exclude failed accounts via API or restart affected processes
   - Rollback recent deployment if correlated
   - Escalate to provider support if upstream issue
   - Implement circuit breaker if pattern repeats
5. **Post-incident** →:
   - Fill out post-mortem
   - Add error rule if new pattern detected
   - Update SLO/SLI if gaps identified
   - Automate toil if repetitive task

### 7.3 Runbook Templates

**Provider-wide failure:**
```
1. Check getUsageStats() → which providers have elevated error rates?
2. Check getActiveRequests() → how many pending requests per provider?
3. Call markAccountUnavailable for all connections of affected provider
   (or wait for cooldown expiry)
4. Monitor error rate for 15m — should trend down as excluded accounts cool down
5. If error rate persists → consider circuit breaker: block entire provider
6. If error rate clears → gradually restore accounts after cooldown
```

**SSE streaming degradation:**
```
1. Check console logs for "STREAM" event lines
2. Check getUsageStats() → stream completion rate
3. Verify STREAM_STALL_TIMEOUT_MS is appropriate for upstream provider
4. Check for executor errors in recent logs
5. If stream failures > 5% → consider forcing non-streaming via Accept header
6. Investigate: executor connectivity, upstream rate limits, quota exhaustion
```

---

## 8. Recommendations Summary

### 8.1 SLO/SLI Definitions (Priority: HIGH)
- [ ] Implement Prometheus metrics endpoint `/metrics`
- [ ] Add request duration histogram observation
- [ ] Define and track 3-5 core SLOs (availability, latency, success rates)
- [ ] Set up error budget alerts (critical/warning/info thresholds)
- [ ] Deploy SLO dashboard (Grafana or similar)

### 8.2 Chaos Engineering Readiness (Priority: MEDIUM)
- [ ] Create failure injection scripts for account exhaustion
- [ ] Document and test stream stall timeout behavior
- [ ] Validate RTK fail-open semantics with corrupted bodies
- [ ] Design combo model exhaustion experiment
- [ ] Set up post-incident metrics collection framework

### 8.3 Incident Response (Priority: HIGH)
- [ ] Create health check endpoint with SLO status
- [ ] Write incident runbook templates (provider failure, streaming degradation)
- [ ] Establish severity mapping and response time SLAs
- [ ] Set up post-mortem template and review process
- [ ] Document on-call rotation and escalation paths

### 8.4 Observability Gaps to Close (Priority: HIGH)
- [ ] Add structured JSON logs with request ID, model, provider, status, latency
- [ ] Implement Prometheus-compatible metrics (request count, error rate, latency histogram)
- [ ] Add distributed tracing for request pipeline (translator → executor → response)
- [ ] Persist in-memory state on process restart
- [ ] Add health check endpoint
- [ ] Implement circuit breaker patterns for failing providers

### 8.5 Error Handling Improvements (Priority: MEDIUM)
- [ ] Add circuit breaker per provider with configurable failure threshold
- [ ] Make token refresh attempt count configurable
- [ ] Add max retry per model in combo fallback
- [ ] Add deployment-time SLO validation gate
- [ ] Quarterly error rule audit against actual error patterns

---
*This ADR is a living document. Review and update quarterly or when significant reliability incidents occur.*