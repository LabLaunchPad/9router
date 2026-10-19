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
sse_requests_total{status="2xx",...} 975
sse_requests_total{status="5xx",...} 25
sse_error_responses_total{...} 25           # => 2.5% of requests failed
```

The counter path computes the **same quantity** as the gauge: the error rate
divided by the target error rate, i.e. the fraction of the error budget that
has been spent. With the default 99.95% availability SLO, a 2.5% error rate
is 50x the budget, so the fallback reports 100% consumed (capped) and the gate
blocks. Every series of a labelled counter is summed — reading only one series
would divide one provider's error count by another provider's request count.

### Configuration

| Variable | Default | Notes |
|---|---|---|
| `SLO_METRICS_ENDPOINT` | — | **Required.** Absolute URL of the authoritative metrics endpoint. |
| `METRICS_ENDPOINT` | — | Documented alias of `SLO_METRICS_ENDPOINT`. |
| `SERVICE_NAME` | `9router` | Reported in the gate output. |
| `ENVIRONMENT` | `production` | Reported in the gate output. |
| `GITHUB_SHA` | `unknown` | Reported in the gate output. |
| `GITHUB_ACTOR` | `unknown` | Recorded in the audit log as the actor. |
| `SLO_WARNING_THRESHOLD` | `50` | Percent. |
| `SLO_BLOCKED_THRESHOLD` | `75` | Percent. |
| `SLO_EXHAUSTED_THRESHOLD` | `95` | Percent. |
| `SLO_WINDOW_SECONDS` | `2592000` | 30 days. See the window note below. |
| `SLO_TARGET_ERROR_RATE` | `0.0005` | The error budget allowance. Must match the app's own target (99.95% availability). |
| `SLO_REQUIRE_FULL_WINDOW` | `false` | Opt in: block when the sample is younger than the window. An unknown age also blocks. |
| `SLO_MIN_SAMPLE_SECONDS` | `0` | Opt in: block when the sample is thinner than this. `0` disables the check. An unknown age also blocks. |
| `SLO_FAIL_CLOSED` | `true` | Set `false` to fail open **on data problems**. A missing endpoint still blocks. |
| `SLO_FETCH_TIMEOUT_MS` | `8000` | Metrics request timeout. |
| `SLO_GATE_OVERRIDE_APPROVED` | `false` | Emergency override. Audited. |
| `SLO_GATE_OVERRIDE` | `false` | Documented alias of `SLO_GATE_OVERRIDE_APPROVED`. |
| `SLO_GATE_OVERRIDE_REASON` | `unspecified` | Recorded in the audit log. |
| `SLO_GATE_SKIP` | `false` | CI-only: skip the gate entirely (repo variable). |

> **The endpoint must be the authoritative one** — a production Prometheus or
> the deployed instance's `/api/metrics`. Do **not** point it at
> `localhost:3000/metrics` on the CI runner: that measures the CI box, not the
> service, and would silently wave through every deploy. The script refuses to
> guess an endpoint.

### What the 30-day window actually means

The counters behind the metric live in the service process, so they cover the
time since the last restart, not the last 30 days. `/api/metrics` publishes
`sse_metrics_sample_age_seconds` so the gate can tell the difference, and the
gate always includes the age in its decision reason — a reader of the job
summary always sees how much of the window the figure covers.

The age is **reported, not enforced, by default**, and that is deliberate:

- A deploy restarts the service, so the sample age at gate time is *seconds*
  old. A check that blocked on the age would block **every** deploy, and a
  gate that can never pass is not a gate — it is an outage with extra steps.
- The figure is still a real measurement of the error rate over the observed
  period, and that is what the thresholds are applied to.

Two opt-in knobs change that:

| Variable | Effect |
|---|---|
| `SLO_REQUIRE_FULL_WINDOW=true` | Block when the sample does not span `SLO_WINDOW_SECONDS`. Only meaningful when the endpoint is a time-series store that outlives a single process lifetime. |
| `SLO_MIN_SAMPLE_SECONDS=300` | Block when the sample is thinner than the given number of seconds — too little data to judge at all. |

When the endpoint does not publish the sample-age gauge at all, the gate says
so in the reason (`sample age unknown`) rather than pretending the window was
covered.

**An explicitly-enabled check is not silently bypassed by an unknown age.** If
the operator turns `SLO_REQUIRE_FULL_WINDOW` or `SLO_MIN_SAMPLE_SECONDS` on and
the endpoint cannot answer the question — because it does not publish
`sse_metrics_sample_age_seconds` — the gate blocks (or warns, with
`SLO_FAIL_CLOSED=false`) rather than passing. An unknown is not a pass: a knob
that quietly does nothing is the same defect as a knob that does not exist.
With both checks off, which is the default, an unknown age is only reported.

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
    if: '!cancelled() && github.event_name == ''push'' && (github.ref == ''refs/heads/main'' || github.ref == ''refs/heads/master'')'
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - name: 📋 Check SLO gate configuration
        env:
          SLO_METRICS_ENDPOINT: ${{ secrets.SLO_METRICS_ENDPOINT }}
          SLO_GATE_SKIP: ${{ vars.SLO_GATE_SKIP }}
          SLO_GATE_OVERRIDE_APPROVED: ${{ vars.SLO_GATE_OVERRIDE_APPROVED }}
        run: |
          if [ -n "$SLO_METRICS_ENDPOINT" ]; then exit 0; fi
          if [ "$SLO_GATE_SKIP" = "true" ]; then
            echo "::warning::SLO gate SKIPPED (SLO_GATE_SKIP=true)."
            exit 0
          fi
          if [ "$SLO_GATE_OVERRIDE_APPROVED" = "true" ]; then
            echo "::warning::SLO gate OVERRIDDEN (SLO_GATE_OVERRIDE_APPROVED=true)."
            exit 0
          fi
          echo "::error::SLO_METRICS_ENDPOINT is not configured. The SLO gate fails closed."
          exit 1
      - name: 🔍 Run SLO validation gate
        if: vars.SLO_GATE_SKIP != 'true' && vars.SLO_GATE_OVERRIDE_APPROVED != 'true'
        continue-on-error: false
        env:
          SLO_METRICS_ENDPOINT: ${{ secrets.SLO_METRICS_ENDPOINT }}
          SLO_GATE_SKIP: ${{ vars.SLO_GATE_SKIP }}
          SLO_GATE_OVERRIDE_APPROVED: ${{ vars.SLO_GATE_OVERRIDE_APPROVED }}
          SLO_GATE_OVERRIDE_REASON: ${{ vars.SLO_GATE_OVERRIDE_REASON }}
          SLO_FAIL_CLOSED: "true"
          ...
        run: node scripts/ci/validate-slo.mjs
```

`continue-on-error: false` is explicit: the job must fail the workflow when
the gate blocks. The configuration pre-check also fails closed — a missing
secret is a configuration error, not a reason to skip the gate silently.

Three things in that wiring are load-bearing and easy to get wrong:

- **The branch.** This repository's default branch is `master`, not `main`.
  The trigger and the job condition both list `main` and `master`; a workflow
  that names only `main` never runs here.
- **The step condition reads `vars.`, not `env.`.** A step's own `if` is
  evaluated before that step's `env:` block is applied to it, so
  `env.SLO_GATE_SKIP` there resolves to the empty string whatever the
  repository variable is set to — the documented skip would be a no-op. `vars`
  is repository-scoped and has no such ordering question. The `env:` block
  still carries the values to the script.
- **`SLO_GATE_SKIP` must reach the gate step**, not only the pre-check.
  Otherwise the skip only changes the error message while the gate still
  fails closed — and the log would claim a skip that never happened.
- **The pre-check must honour the audited override**, for the same reason:
  the script is the only place that honours it, so a pre-check that does not
  would make the override unusable in exactly the misconfigured-endpoint case
  it exists for.

The gate job's condition is `!cancelled() && …`, so it still runs and reports
its decision when the drift check failed. A bare condition would skip the gate
whenever its dependency failed, leaving the operator with one red job and no
SLO verdict.

Disabling the gate is possible, but only through the explicit, visible
`SLO_GATE_SKIP` repository variable — and a skip is always reported in the job
summary, never silently treated as a pass.

### The drift check the gate rides on

The gate job lives inside `.github/workflows/drift-prevention.yml`, so that
workflow has to actually work for the gate to ever run. It had three
independent reasons not to, all of them fixed here:

- **`npm ci` can never work in this repository.** `package-lock.json` is
  gitignored (`.gitignore` line 63), so `npm ci` fails with `EUSAGE` on every
  run and the job died at its first step. The workflow uses `npm install`, like
  the `Dockerfile` and the `gitbook-pages` workflow already do. The cost is
  that the installed tree is not pinned; committing a lockfile is a maintainer
  decision about the repository's dependency policy, not a side effect of this
  branch.
- **The baseline was the same commit as the run it was compared against.**
  Running the suite twice on one tree cannot detect a regression: with
  identical code on both sides the failure sets are identical, so the
  comparison only ever detects *flakes* — and it hard-failed the job on them.
  The baseline is now the **base commit**: the workflow checks it out, runs the
  suite there, and checks the change back out. "Fails now, passed on the
  base" then means what it says.
- **The failure count was read from reporter-specific marker characters**
  (`×` / `✖`), and the baseline used a different reporter from the new run, so
  the two counts were not comparable. The count now comes from vitest's own
  summary line (`Tests  77 failed | 3695 passed | …`), which every reporter
  emits identically.

The comparison itself:

- The **set** of failing files is compared, not just the count. A change that
  fixes one test and breaks another leaves the count unchanged; the file set
  does not.
- A **newly failing file is re-run on its own** and judged by its exit code.
  A test that passes on the second run was flaky, and a flaky test must not
  fail the build. A candidate that cannot be run at all is *not* a pass — it
  stays a regression, because an unknown is not evidence that the change is
  innocent.
- **Unresolvable imports are compared too.** This repository has test files
  that import packages nobody declared (`lowdb`); those are part of the known
  pre-existing failures, so an unresolvable import is not a failure on its
  own. A *new* one is: it means the change added a dependency that does not
  exist.
- The `paths:` filter covers the whole source tree (`src/**`, `open-sse/**`,
  `scripts/**`, `tests/**`) rather than an enumeration of the files the
  controls happen to touch. An earlier list missed
  `src/shared/constants/providers.js` — which keys the breaker and the
  failure-burst map — and `src/lib/localDb.js`, and a pull request touching
  either ran no CI at all. A hand-maintained list cannot stay correct.

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
| Endpoint unreachable / the metrics fetch fails | Set `SLO_FAIL_CLOSED=false` (fail open on data problems). The decision is reported as `warn`, not `block`, so the summary does not claim a block that did not happen. |
| Endpoint secret is not set yet | Set the `SLO_GATE_SKIP` repo variable to `true` to skip the gate explicitly — it is visible in the repo settings, unlike a silent skip. `SLO_FAIL_CLOSED=false` does **not** cover this case: a gate with no endpoint cannot say anything about the budget, so it blocks. |
| The figure covers less than the SLO window | Nothing to do — that is the default and the coverage is reported in the decision reason. Set `SLO_REQUIRE_FULL_WINDOW=true` to enforce it, or point the gate at a time-series store that does span the window. |
| The metric has almost no data | Set `SLO_MIN_SAMPLE_SECONDS=300` to refuse to judge a sample that is too thin to be meaningful. |
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

Every write gets its **own** temp file (`<target>.<pid>.<tag>.<n>.tmp`). Two
writers must never share a temp path: the periodic async writer and the
synchronous shutdown writer can overlap, and a shared path means the shutdown
snapshot is truncated by the other writer (or vice versa) — the async rename
then fails with ENOENT and the file on disk is the wrong snapshot. A failed
write unlinks its temp file, and the process no longer leaks one `.tmp` file
per interrupted restart.

The snapshot file is versioned (`version: 1`). A file with an unknown version
is discarded with a `sse_state_version_mismatch` warning rather than
mis-applied.

### What is restored

The persisted pending counters describe requests that were **in flight when
the previous process stopped** — they were killed by the restart and will
never complete. Restoring them into the live in-flight gauge would make
`pendingRequests` permanently non-zero, because nothing ever decrements a
counter for a request that no longer exists. They are restored as a separate
`droppedOnRestart` figure instead, surfaced by `/api/health` as
`droppedOnRestart` / `droppedByModel`, and the live gauge stays truthful.

The ring buffer is **not** restored by claiming `initialized`. That flag is
`usageRepo`'s: setting it during the restore would suppress the SQLite
rehydration and silently discard the persisted request history.

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

The listeners are attached with `process.on`, not `process.once`. Node removes
a `once` listener from the array *before* the handler body runs, so a
`process.listeners(signal).length <= 1` check inside the handler would count
only the *other* listeners — and the handler would call `process.exit(0)` even
though `initializeApp.js` has its own SIGTERM handler, truncating the app's
cleanup (`killCloudflared()`, `killAllBridges()`). The `handlersRegistered`
module guard is what prevents double registration; `process.once` was never
needed for that and actively broke the exit check.

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
requests dropped by the last restart, error-budget remaining, the last error
provider, per-provider circuit-breaker state, and process uptime. It exposes
no request payloads, credentials, or user data.

The error-budget figure is derived from the **same** counters the SLO gate
reads (`computeErrorBudgetConsumed`), so the health view and the deploy gate
can never disagree. `status` is derived from that budget (`"degraded"` below
25% remaining) rather than hardcoded to `"ok"`.

The route carries two deliberately separate signals:

| Field | Meaning |
|---|---|
| `ok` | **Liveness.** The service answered. Always `true` for a 200 response, so an existing probe that reads `ok` keeps working. |
| `status` | **Readiness.** The SLO state: `"ok"` or `"degraded"`. |

The HTTP status stays 200 even when the service is degraded: a load balancer
should not pull a still-serving instance out of rotation over a soft SLO
signal. A probe that wants the SLO state reads `status`; one that only wants
to know the process is up reads `ok` or the HTTP status.

The route keeps its original contract: the `ok: true` field, the CORS headers
(`Access-Control-Allow-Origin: *`) and the `OPTIONS` handler. The dashboard
pings other instances cross-origin — see
`src/app/(dashboard)/dashboard/endpoint/endpointPing.js`, whose own comment
says *"/api/health route sets Access-Control-Allow-Origin: * -> CORS works
through tunnel"* — so dropping them silently breaks the endpoint-alive
indicator for every remote instance.

### Circuit breaker semantics

The breaker is a **provider-level** control, and the distinction matters:

| Signal | Trips the provider circuit? | Why |
|---|---|---|
| `5xx`, transport error (no status) | **Yes** | The provider is failing; every account will fail the same way. |
| `401`, `402`, `403`, `429` | **No** | About one credential. The provider itself is healthy. |
| "no credentials configured" | **No** | A local configuration problem, and no upstream call is made. |
| "every account locked or rate-limited" | **No** | Same: the provider is healthy and no upstream call is made. |
| A successful upstream response | Closes the circuit | The provider demonstrably answered. |

Two details that are easy to get wrong, and that this implementation gets
right:

- **A success is recorded on the response, not on credential selection.**
  Picking a credential says nothing about whether the provider answered; a
  provider that is down still hands out credentials happily.
- **A burst of failures for the same provider is ONE outage.** The
  account-fallback loop tries the next credential whenever an account fails,
  so a single client request against a provider returning 500 produces one
  failure *per account*. Counting those separately would open the circuit
  after a single request and let one client take a whole provider out of
  service for the cool-down window. Failures for the same provider within
  `failureBurstMs` (2 s by default, per provider, configurable through
  `CIRCUIT_BREAKER_CONFIG`) are therefore collapsed into one.
- **The burst window is anchored at the start of the burst** and is not moved
  by a failure that was suppressed. If it slid, then during a continuous
  outage every failure would fall inside the window, only the first would be
  counted, and the circuit would stay closed for the whole outage — the
  provider is hammered by every request and every account is locked in the
  meantime, which is the exact situation the breaker exists for. A failure
  that is more than `failureBurstMs` after the last *counted* failure starts a
  new burst and is counted.

The half-open state admits exactly **one** probe request. The probe slot is
claimed by `canRequest()` and released by the success/failure record — and
explicitly by `releaseProbe()` on the paths where no upstream request is made
at all (no credentials, every account locked), because otherwise the
provider would be blackholed for the whole reset window by a purely local
problem. A provider that *answers* — even with a `401` or a `429` — also
resolves the probe: the probe asked "does this provider work now?", the
provider replied, so the probe succeeded. Without that, a recovered provider
that answered `429` would be blackholed for the rest of the reset window
(fifteen minutes by default) even though it was working. Reading the
breaker's state (`getState()`, used by `/api/health` and `/api/metrics`) is
side-effect free: a metrics scrape must never half-open a circuit that is
supposed to be failing fast.

### `GET /api/metrics`

Prometheus text exposition. Exports `sse_requests_total`,
`sse_error_responses_total`, `sse_request_latency_seconds` (a fixed-bucket
histogram, so memory is bounded regardless of traffic),
`sse_error_budget_consumed`, `sse_circuit_breaker_state`, and
`sse_metrics_sample_age_seconds`.

The `sse_error_budget_consumed` gauge is the signal the SLO gate reads. The
sample-age gauge is what lets the gate tell whether the sample spans the SLO
window — see the window note in section 1.

Both routes are in the dashboard guard's `PUBLIC_API_PATHS`: the SLO gate
fetches `/api/metrics` unauthenticated (no cookies, no bearer token), so it
has to be reachable. The payload is operational metadata only — request
counters, latency histograms, breaker states and the error-budget gauge. No
request payloads, credentials, headers or user data are exposed.

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
