# Production Readiness Controls

Three operational controls added to 9Router:

1. **SLO validation gate** — blocks a deploy when the error budget is exhausted.
2. **SSE state persistence** — survives a graceful restart without leaking secrets.
3. **Chaos engineering suite** — six provider/failure scenarios, network-free.

Each section states what it does, how it is configured, how to verify it, and
how to roll it back.

---

## 1. SLO Validation Gate

### What it does

`scripts/ci/validate-slo.mjs` queries a Prometheus-compatible metrics endpoint,
converts the error-budget consumption into a percentage, and applies a
deployment policy:

| Budget consumed | Decision | Exit code | Meaning |
|---|---|---|---|
| `< 50%` | `allow` | `0` | Deploy normally |
| `50% – 75%` | `warn` | `2` | Manual approval required |
| `75% – 95%` | `block` | `1` | Deployment blocked |
| `>= 95%` | `block` | `1` | Budget exhausted — blocked |
| No / malformed / unreachable metrics | `block` | `1` | **Fails closed** |
| `SLO_METRICS_ENDPOINT` not configured | `block` | `1` | **Fails closed** — no localhost fallback |

The gate is a **fail-closed** control by default: missing, malformed, or
unavailable SLO data blocks the deploy rather than waving it through. Set
`SLO_FAIL_CLOSED=false` to invert the data-unavailable cases (not
recommended).

There is deliberately **no localhost fallback**. A CI runner's
`http://localhost:3000/metrics` measures the *runner*, not the service, so it
would report a healthy budget and wave through every deploy. An unset
endpoint is a configuration error and fails closed.

### The signal it reads

Prefer the explicit gauge exported by `/api/metrics`:

```
sse_error_budget_consumed 0.42        # fraction 0..1 of the budget used
```

If the gauge is absent, the script falls back to the request counters:

```
sse_requests_total 1000
sse_error_responses_total 25           # => 2.5% of requests failed
```

Note that the counter fallback measures the *raw* error rate, not the budget
consumption — a 2.5% error rate is far past a 99.95% SLO. Prefer the gauge.

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `SLO_METRICS_ENDPOINT` | — | **Required.** Absolute URL of the authoritative metrics endpoint. |
| `SERVICE_NAME` | `9router` | Reported in the gate output. |
| `ENVIRONMENT` | `production` | Reported in the gate output. |
| `GITHUB_SHA` | `unknown` | Reported in the gate output. |
| `SLO_WARNING_THRESHOLD` | `50` | Percent. |
| `SLO_BLOCKED_THRESHOLD` | `75` | Percent. |
| `SLO_EXHAUSTED_THRESHOLD` | `95` | Percent. |
| `SLO_WINDOW_SECONDS` | `2592000` | 30 days. |
| `SLO_FAIL_CLOSED` | `true` | Set `false` to fail open. |
| `SLO_FETCH_TIMEOUT_MS` | `8000` | Metrics request timeout. |
| `SLO_GATE_OVERRIDE_APPROVED` | `false` | Emergency override. Audited. |
| `SLO_GATE_OVERRIDE_REASON` | `unspecified` | Recorded in the audit log. |
| `SLO_GATE_SKIP` | `false` | CI-only: skip the gate entirely (repo variable). |

> **The endpoint must be the authoritative one** — a production Prometheus or
> the deployed instance's `/api/metrics`. Do **not** point it at
> `localhost:3000/metrics` on the CI runner: that measures the CI box, not the
> service, and would silently wave through every deploy. The script refuses to
> guess an endpoint.

The script has **zero runtime dependencies** (native `fetch`, Node 18+), so the
CI job needs no `npm install` for it.

### Emergency override

The override is explicit and audited. It is checked **first**, so it wins even
when the metrics endpoint is misconfigured. The gate logs the actor, the
timestamp, the reason, and the git SHA:

```json
{"event":"slo_validation_gate","decision":"allow","override":true,
 "overrideReason":"hotfix for INC-4711","actor":"release-bot","gitSha":"87a74e1b"}
```

In GitHub Actions, set the **repository variable** `SLO_GATE_OVERRIDE_APPROVED`
to `true` and `SLO_GATE_OVERRIDE_REASON` to a ticket reference. Repository
variables (not secrets) are used deliberately so the approval is visible in
the repo settings to anyone reviewing a release.

### CI wiring

The `slo-validation-gate` job lives in `.github/workflows/drift-prevention.yml`
(the repo has no `deploy.yml`; if one is added later, move the job there — it
is a self-contained job with no dependencies on the drift steps).

```yaml
  slo-validation-gate:
    runs-on: ubuntu-latest
    needs: test-drift
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - name: 📋 Check SLO gate configuration
        env:
          SLO_METRICS_ENDPOINT: ${{ secrets.SLO_METRICS_ENDPOINT }}
          SLO_GATE_SKIP: ${{ vars.SLO_GATE_SKIP }}
        run: |
          if [ -n "$SLO_METRICS_ENDPOINT" ]; then exit 0; fi
          if [ "$SLO_GATE_SKIP" = "true" ]; then
            echo "::warning::SLO gate SKIPPED (SLO_GATE_SKIP=true)."
            exit 0
          fi
          echo "::error::SLO_METRICS_ENDPOINT is not configured. The SLO gate fails closed."
          exit 1
      - name: 🔍 Run SLO validation gate
        continue-on-error: false
        env:
          SLO_METRICS_ENDPOINT: ${{ secrets.SLO_METRICS_ENDPOINT }}
          SLO_GATE_OVERRIDE_APPROVED: ${{ vars.SLO_GATE_OVERRIDE_APPROVED }}
          SLO_GATE_OVERRIDE_REASON: ${{ vars.SLO_GATE_OVERRIDE_REASON }}
          SLO_FAIL_CLOSED: "true"
          ...
        run: node scripts/ci/validate-slo.mjs
```

`continue-on-error: false` is explicit: the job must fail the workflow when
the gate blocks. The configuration pre-check also fails closed — a missing
secret is a configuration error, not a reason to skip the gate silently.
Disabling the gate is possible, but only through the explicit, visible
`SLO_GATE_SKIP` repository variable.

### Verification

```bash
# Healthy budget -> exit 0
SLO_METRICS_ENDPOINT=https://metrics.internal/metrics node scripts/ci/validate-slo.mjs; echo $?

# Missing endpoint -> exit 1 (fail closed, no localhost fallback)
node scripts/ci/validate-slo.mjs; echo $?

# Emergency override -> exit 0, audited
SLO_GATE_OVERRIDE_APPROVED=true SLO_GATE_OVERRIDE_REASON="INC-4711" \
  node scripts/ci/validate-slo.mjs; echo $?
```

Unit tests: `tests/unit/slo-gate.test.js` (42 cases) covering the healthy /
warning / blocked / exhausted decision matrix, a missing metric, invalid
Prometheus text, an HTTP failure, a timeout, the fail-open opt-out, the
override (including that it wins over a misconfigured endpoint), and the
process-level exit codes via a real child-process run.

### Rollback

| Situation | Action |
|---|---|
| Gate blocks a legitimate deploy | Set `SLO_GATE_OVERRIDE_APPROVED=true` + a reason. The decision is logged with the actor and SHA. |
| Gate is misconfigured / endpoint unreachable | Set `SLO_FAIL_CLOSED=false` (fail open on data problems). |
| Endpoint secret is not set yet | Set the `SLO_GATE_SKIP` repo variable to `true` to skip the gate explicitly — it is visible in the repo settings, unlike a silent skip. |
| Gate must be removed entirely | Delete the `slo-validation-gate` job from `.github/workflows/drift-prevention.yml`. Nothing else depends on it — the script is standalone and is not imported by the app. |

The gate is a pure CI-side control: it never runs inside the application and
cannot affect request handling. Removing it is always safe.

---

## 2. SSE State Persistence

### What it does

`src/sse/services/state-persistence.js` persists a small, non-sensitive slice
of in-memory SSE operational state so a graceful restart does not lose it:

- in-flight request counters (`global._pendingRequests`)
- the last known error provider (`global._lastErrorProvider`)
- optionally, a sanitised recent-requests ring buffer

It is wired into `src/instrumentation.js`, which runs on server startup:

```js
const { registerStatePersistence, restorePersistedState } =
  await import("@/sse/services/state-persistence.js");
await restorePersistedState();
registerStatePersistence();
```

### What is never persisted

The sanitiser is an **allow-list**, not a deny-list: only explicitly permitted
fields are written, everything else is dropped.

| Persisted | Never persisted |
|---|---|
| Model / provider counters | API keys, tokens, cookies, secrets, credentials |
| Connection id, provider, model, endpoint | Prompt or completion text, request/response bodies |
| Token **counts** (numeric leaves only) | Raw HTTP headers |
| Cost, status, timestamps | PII of any kind |
| `persistedAt`, `uptimeSeconds` | Sockets, streams, timers, connection objects |

The ring buffer entries in `usageRepo` carry an `apiKey` field. That field is
**not** in the allow-list, so it is dropped even when ring persistence is
enabled. A unit test asserts the secret never appears in the serialised
snapshot.

The ring buffer is **off by default** (`SSE_STATE_PERSIST_RING` defaults to
`false`) because `usageRepo` already rehydrates it from SQLite on startup, so
persisting it is redundant and widens the on-disk data surface.

### Crash safety

Writes are atomic: **temp file → `fsync` → `rename`**. A crash mid-write
therefore leaves either the previous complete file or the new complete file —
never a truncated one. `fsync` failures are tolerated (some container
overlays do not support it); the rename is still atomic, so this is a
durability nicety, not a correctness requirement.

The snapshot file is versioned (`version: 1`). A file with an unknown version
is discarded with a `sse_state_version_mismatch` warning rather than
mis-applied.

### Request-path safety

Nothing in this module runs on the request path.

- The periodic snapshot is an **async**, debounced write (default 5 s).
- The shutdown write is **synchronous** — deliberately so. Other shutdown
  handlers in the app (`src/shared/services/initializeApp.js`) call
  `process.exit()` as soon as they run, which would kill an in-flight async
  write mid-file. The sync write runs exactly once, during shutdown.

The handler does **not** call `process.exit()` itself unless it is the only
signal listener; the app's own handler owns the exit, and this one just makes
sure the snapshot is on disk first.

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `SSE_STATE_DIR` | the app data dir (`DATA_DIR`) | Where the state file lives. |
| `SSE_STATE_SNAPSHOT_INTERVAL_MS` | `5000` | Debounce / periodic snapshot interval. |
| `SSE_STATE_PERSIST_RING` | `false` | Set `true` to also persist the sanitised ring buffer. |

State file name: `sse-state.json` inside `SSE_STATE_DIR`.

### Observability

Every failure path emits a structured JSON log:

| Event | Level | When |
|---|---|---|
| `sse_state_persistence_registered` | info | Handlers registered. |
| `sse_state_persisted` | info | Periodic snapshot written. |
| `sse_state_persisted_on_shutdown` | info | Snapshot written during shutdown. |
| `sse_state_restored` | info | State restored at startup. |
| `sse_state_no_snapshot` | info | Nothing to restore. |
| `sse_state_read_failed` | warn | State file unreadable. |
| `sse_state_parse_failed` | warn | State file is not valid JSON. |
| `sse_state_version_mismatch` | warn | State file version unknown. |
| `sse_state_restore_failed` | error | Restore threw. |
| `sse_state_persist_failed` | error | Write threw. |

### Verification

```bash
# Round trip
node -e "import('./src/sse/services/state-persistence.js')"   # module loads
ls "$DATA_DIR/sse-state.json"                                  # after a restart
```

Unit tests: `tests/unit/sse-state-persistence.test.js` (30 cases) covering the
atomic write, idempotency, secret redaction, restore round-trip, version
mismatch, the synchronous shutdown writer, and the single-registration
guarantee for the signal handlers.

### Rollback

The feature is safe to disable without a code change:

```bash
# Disable entirely (no file written, nothing restored)
SSE_STATE_DIR=/dev/null          # or point it at a throwaway path
```

For a full code rollback, delete the `state-persistence` block from
`src/instrumentation.js` and remove `src/sse/services/state-persistence.js`.
Nothing else imports the module, so removal is a clean revert. The state file
itself is inert — it is only read by this module — so it can be deleted at any
time.

---

## 3. Chaos Engineering Suite

### The scenarios

`tests/chaos/provider-failures.test.js` covers six provider/failure scenarios
(24 cases).

| # | Scenario | What is asserted |
|---|---|---|
| 1 | **Account kill switch** | The provider circuit opens at the failure threshold, refuses requests while open, and closes again after the cool-down. |
| 2 | **Latency spike** | A slow model that eventually answers is served; a slow model that fails falls through to the next one. |
| 3 | **Translator / RTK corruption** | A malformed tool result is passed through untouched; a panicking filter fails open; strict mode rethrows; the request body is never corrupted. |
| 4 | **Provider timeout** | A combo whose members all time out returns 5xx; no upstream call is attempted while the circuit is open. |
| 5 | **Combo model exhaustion** | Every model is attempted, the exhausted response is 503, and the earliest `retry-after` hint reaches the client. A 200 with zero content is treated as a failure and keeps the fallback chain going. |
| 6 | **Fusion judge timeout** | A hung judge is capped by the panel hard timeout and the request degrades to a surviving panel answer instead of hanging forever. |

### Running it

The chaos suite is **excluded from the default test run** so a destructive
scenario can never gate an ordinary pull request.

```bash
# Default suite (chaos excluded)
npx vitest run

# Chaos suite
npx vitest run --config tests/chaos/vitest.config.js
```

CI: `.github/workflows/chaos-engineering.yml` runs it on `workflow_dispatch`
and on a weekly schedule (Sunday 03:17 UTC).

### Network-free by design

Failures are injected through the existing dependency-injection seams
(`handleSingleModel`, `getCircuitBreaker`, the RTK entry points) rather than
by contacting a live upstream. The suite needs no credentials, no accounts,
and no network, which keeps it deterministic and safe to schedule.

### Defects this suite found

The suite was written against the production code, not against a mock of it,
so it surfaced real defects. All are fixed:

| Defect | Fix |
|---|---|
| `circuitBreaker.js` treated an explicit `coolDownWindowMs: 0` as falsy, so a zero cool-down was impossible to configure. | Numeric validation instead of `\|\|` (file: `open-sse/services/circuitBreaker.js`). |
| `auth.js` imported `recordFailure` / `recordSuccess` from `circuitBreaker.js`, which exports neither — a hard `SyntaxError` that broke module loading. | Use the breaker instance methods (file: `src/sse/services/auth.js`). |
| `auth.js` imported `{ registry }` from a module that only has a default export — another hard `SyntaxError`. | Use the default import, matching the rest of the repo (file: `src/sse/services/auth.js`). |
| Circuit-breaker success was recorded only for *pinned* connections, and the log line was duplicated. | Record success on every valid credential selection (file: `src/sse/services/auth.js`). |
| `resetAllCircuitBreakers()` reset instances in place, so a re-created breaker kept the old config — behaviour depended on test ordering. | Clear the registry (file: `open-sse/services/circuitBreaker.js`). |
| The fusion **judge** call had no timeout (only the panel did), so a hung judge stalled the request forever. | The judge is capped by the same hard timeout and degrades to a panel answer (file: `open-sse/services/combo.js`). |
| The combo read the retry hint from the JSON body, but the hint travels in the `retry-after` **header** — the `unavailableResponse` path was unreachable and clients never got a retry hint. | Read the header and normalise it to an ISO timestamp (file: `open-sse/services/combo.js`). |

### Related fix: RTK strict mode was inert

Scenario 3 exercises the RTK fail-open contract, which exposed that the
opt-in strict mode could never fire: `injectSystemPrompt` and every helper
below it swallowed all errors internally, so the `catch { if (strict) throw }`
in `caveman.js` / `ponytail.js` was unreachable, and `headroom.js` computed a
`strict` local but then used the module-level constant in the catch.

The fix threads the flag down to the mutating helpers and uses the local:

- `open-sse/rtk/systemInject.js` — `injectSystemPrompt(body, format, prompt, strict)`;
  the `strict` flag is passed to each format helper, which rethrows instead of
  swallowing.
- `open-sse/rtk/caveman.js`, `open-sse/rtk/ponytail.js` — pass `strict` down.
- `open-sse/rtk/headroom.js` — the catch block now uses the resolved `strict`
  local, so the per-call override is honoured.

Fail-open remains the default: every `tests/unit/system-inject.test.js`
assertion still passes unchanged. Strict mode is covered by
`tests/unit/rtk-strict-mode.test.js` (19 cases).

### Rollback

The chaos suite is test-only. Removing `tests/chaos/` and the
`chaos-engineering.yml` workflow reverts it completely.

The **production fixes** it uncovered are independent of the suite and should
be kept. If any of them must be reverted in isolation, see the file column —
each is a self-contained change. The RTK strict-mode change is likewise
backward compatible: dropping the `strict` argument restores the previous
fail-open behaviour exactly.

---

## Appendix: observability endpoints

Two read-only endpoints were added alongside these controls.

### `GET /api/health`

Operational health snapshot: pending request counts, active connections,
error-budget remaining, the last error provider, per-provider circuit-breaker
state, and process uptime. It exposes no request payloads, credentials, or
user data.

The error-budget figure is derived from the **same** counters the SLO gate
reads (`computeErrorBudgetConsumed`), so the health view and the deploy gate
can never disagree.

### `GET /api/metrics`

Prometheus text exposition. Exports `sse_requests_total`,
`sse_error_responses_total`, `sse_request_latency_seconds` (a fixed-bucket
histogram, so memory is bounded regardless of traffic),
`sse_error_budget_consumed`, and `sse_circuit_breaker_state`.

The `sse_error_budget_consumed` gauge is the signal the SLO gate reads.

### How the counters are fed

`src/sse/services/metrics.js` exposes `instrumentHandler(handler, meta)`, which
records the status class and the latency of a request and then returns the
response untouched. `handleChat` in `src/sse/handlers/chat.js` is wrapped with
it, so `/v1/chat/completions`, `/v1/messages` and `/v1/responses` are all
counted. Other modalities can be wired the same way — one call per handler.

**Known limitation:** for a streaming response the status is fixed at 200 once
the headers are committed, so a stream that fails mid-flight is counted as a
success. The error budget therefore under-counts mid-stream failures. Feed
the `sse_error_budget_consumed` gauge from a more accurate source if you need
that precision — the gate prefers the gauge over the counters.

### Verification

Unit tests: `tests/unit/sse-metrics.test.js` (28 cases) covering the
counters, gauges, the bounded-bucket histogram, the error-budget
computation, the Prometheus rendering, and the handler wrapper.

```bash
curl -s localhost:20127/api/metrics | head -20
curl -s localhost:20127/api/health | head -20
```

### Rollback

Both are additive routes. Delete `src/app/api/health/route.js` and
`src/app/api/metrics/route.js` to remove them. The SLO gate degrades to a
block (fail-closed) if the metrics endpoint disappears, so remove the gate job
at the same time if you are rolling both back.
