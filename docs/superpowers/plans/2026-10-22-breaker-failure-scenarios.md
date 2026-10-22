# Next phase: the breaker's failure scenarios, and the sign-in paths

**Date:** 2026-10-22
**Base:** `master` @ `8f970fb0` (PR #3 and PR #4 merged)
**Branch:** `phase/breaker-failure-scenarios`

---

## 1. Why this phase exists

Two pull requests went in on 2026-10-22. PR #3 closed a live outage (the five
local speech providers refused every request) and closed the image path's
declared gap. PR #4 gave the two xAI sign-in paths a test each.

Both were asked for. Neither was the end of the story, and this plan is what
the end of the story turned out to be. Three things came out of checking the
failure scenarios rather than assuming them:

1. **A sign-in path that cannot work.** The xAI pasted-code fallback is the
   answer to "the local callback server could not start". It needs the
   session to do its job, and the session is only registered when the local
   server started. So the fallback is refused in exactly the case it exists
   for.
2. **Failure scenarios that are used but not proven.** The breaker's decision
   table has thirteen outcomes. Markers for all thirteen are in the test
   suite — and a marker is not a proof. The mutation sweep below breaks each
   branch and watches the suite: a branch that no test catches is a rule that
   nothing enforces.
3. **A check that asks about the wrong thing.** The success-path check asks
   whether a *file* resolves the probe. The breaker is per *provider*, with
   one probe slot, and the resolution is per provider too — so the file-level
   question is right for most files and wrong for one shape. The shape is
   named in `PRODUCTION_READINESS_CONTROLS.md` as a declared limit. This
   phase replaces the declaration with a rule, or says why it cannot.

---

## 2. What was measured

### 2.1 The breaker is per provider, with one probe slot

From `open-sse/services/circuitBreaker.js`:

| fact | where | what it means |
|---|---|---|
| one breaker instance per provider | `getCircuitBreaker(providerId, config)` | the probe slot is per provider, not per request |
| one `probeInFlight` flag per breaker | `canRequest()` | a second claim for the same provider is REFUSED while the first is in flight |
| `canRequest()` claims the slot | `probeInFlight = true` | a claim has to be answered by a resolution |
| `releaseProbe()` gives it back | `state !== HALF_OPEN` → no-op | a path that made no upstream call must release, not resolve |

The consequence that shapes the whole phase: **two claims for the same
provider cannot be in flight at once**, and **one resolution settles the
provider's slot**. So a per-file success check is sound for a file whose
lookups are for the same provider or in mutually exclusive branches — which
is every file in the tree today (measured below) — and unsound for a file
that can claim a probe on one branch and settle it on another.

### 2.2 The paths that obtain a credential

Measured over every file in `src/` and `open-sse/` that calls
`getProviderCredentials`:

| file | lookups | the same provider? | reachable from each other? | a success resolver? |
|---|---|---|---|---|
| `src/sse/handlers/imageGeneration.js` | 2 | yes | no — the no-credential branch returns | yes, in each branch |
| `src/sse/handlers/stt.js` | 2 | yes | no — the no-credential branch returns | yes, in each branch |
| `src/sse/handlers/tts.js` | 2 | yes | no — the no-credential branch returns | yes, in each branch |
| `src/sse/handlers/search.js` | 2 | no — the second is a fallback provider | yes, in sequence | yes, in a callback |
| `src/sse/handlers/videoGeneration.js` | 2 | no — two different handlers | no | yes, in each |

**Five files have more than one lookup. No file has the leaking shape.** The
per-file rule does not hide a live defect today. That is the honest reading,
and it is why Task 3 is a rule rather than a rescue.

### 2.3 The two shapes a success resolver comes in

| shape | example | the failure rule's verdict | the success rule's verdict |
|---|---|---|---|
| a branch on a success flag | `if (result.success) { await clearAccountError(...) }` | counts | counts |
| the success callback the core is handed | `onRequestSuccess: async () => { await clearAccountError(...) }` | does NOT count — it may not run on the failure path | must count — it IS the success path |

The failure rule refuses a callback on purpose: a callback that resolves the
probe when the request succeeds says nothing about the failure path. A
success rule that reused it would refuse every callback, and every callback
is a success resolver. **That is the false positive that stopped the earlier
attempt**, and it is why the success rule needs its own shape test.

### 2.4 The mutation sweep

Every branch of the breaker's decision table was broken in turn, and the
suite was run. The exit code is the verdict.

The result is in section 4 of this plan, written after the sweep.

---

## 3. The work

### Task 1 — the xAI pasted-code fallback (P1)

**The defect.** `src/app/api/oauth/[provider]/[action]/route.js`:

```js
const result = provider === "xai" ? await startXaiProxy(Number(appPort)) : ...;
let serverSide = false;
if (result.success && state && codeVerifier && redirectUri) {
  serverSide = provider === "xai"
    ? registerXaiSession({ state, codeVerifier, redirectUri })
    : registerCodexSession({ state, codeVerifier, redirectUri });
}
```

The session carries the PKCE verifier and the redirect — the two things the
pasted-code exchange needs. It is registered only when the proxy started. So
when the proxy did **not** start, the session is not there, and:

```js
async function completeXaiManualCode(code, state) {
  const session = state ? getXaiSessionStatus(state) : null;
  if (!session) throw new Error("xAI OAuth session not found; restart the login flow and paste the code again");
```

…refuses every pasted code. The error tells the user to restart the login
flow, and the restart hits the same failure. The fallback cannot work.

**The fix.** Register the session whenever the state, the verifier and the
redirect are there. The proxy and the session are two different things: the
proxy LISTENS, the session CARRIES. `serverSide` keeps its meaning — it says
the server will do the exchange itself, which it will not, if nothing is
listening — so it stays false when the proxy did not start.

**The cases.**

| # | case | what it pins |
|---|---|---|
| 1 | the proxy cannot start, and the session is registered anyway | the fallback has what it needs |
| 2 | the pasted code is then exchanged, and the connection is created | the fallback works |
| 3 | `serverSide` is false when the proxy did not start | the client is not told the server will exchange |
| 4 | the proxy starts: the session is registered and `serverSide` is true | the normal path is unchanged |
| 5 | a pasted code for a session that was never registered is refused | the refusal still exists for the real reason |

**Not in scope:** the codex path has the same shape, but codex has no
pasted-code route, so the bug does not bite it. Changing codex would be a
behaviour change on a live path with no failing case to point at.

**What was done.** The session is registered whenever the state, the
verifier and the redirect are there; `serverSide` stays false when the proxy
did not start. The new case was RED before the fix — the session was
`undefined` — and is GREEN after it.

### Task 2 — the failure scenarios nobody proves (P2)

Every survivor of the sweep gets a case that fails when the branch is
broken. The case is written against the branch, not against the words.

**What the sweep found.** Two survivors, and both were cases where a test
looked like it covered something and did not:

| survivor | what it really was | the case that closes it |
|---|---|---|
| a transport error is not a provider-level failure | the test said "transport error with no status" and called `recordDistinctFailures(3, undefined)` — and the helper had `status = 500` as a DEFAULT PARAMETER, so `undefined` became 500 and the test was a second copy of the 5xx test | the helper lost its default, every call site says what it means, and the test now really records a status-less failure |
| an abandoned request is not counted | no test in the tree mentioned `sse_provider_aborted_requests_total` at all | the counter is asserted, the way the local-failure counter is |

**And one that the sweep found by accident.** The breaker's own
`releaseProbe()` was never proven: breaking `this.probeInFlight = false;`
changed nothing the tests could see, because `probeStartedAt` is zeroed as
well and the staleness check passes on its own. The check that sees the
difference is `isAvailable()` — the pure availability check a health probe
reads — and **no test called it at all**. It does now, in the two release
paths and in the observability file.

### Task 3 — the per-branch success check (P3)

**What it would be.** For each credential lookup, ask: *is there a success
resolver that this lookup's path reaches?* instead of *does this file have a
success resolver somewhere*.

**What it needs that does not exist yet.** The success rule needs to know two
things the scope model cannot say:

- a resolver inside a callback IS on the success path (the failure rule says
  the opposite, on purpose);
- a claim inside a conditional reaches a call FURTHER DOWN the same block —
  the `search.js` shape, where the claim is in an `if` and the callback that
  resolves it is created after the `if` closes.

The second is the hard one. The model that can say it is a **carrier**: the
call whose argument holds the resolver (`handleSearchCore({ ..., onRequestSuccess: ... })`).
A lookup reaches a resolver when the carrier's statement comes AFTER the
lookup and the carrier sits in a block that encloses the lookup.

**The shape of the work.**

1. A carrier finder: the call statement a resolver is an argument of.
2. A reachability rule: lookup → carrier → resolver, with the order and the
   block nesting checked.
3. Fixtures for every shape — a fixture that proved something else would
   prove nothing, and the real tree does not contain the shapes the rule
   exists to reject.
4. The rule replaces the per-file rule only if it is measured to be at least
   as strict on today's tree: it must still pass every file that passes now,
   and it must catch the fixture that the per-file rule misses.

**What it costs.** The rule is a scan, so it is a piece of source-analysis
code that has to be right. The measure of it is the mutation sweep: break
the rule and the fixture must fail.

**What happens if it cannot be built.** The declared limit stays, and this
plan says so. A rule that guesses is worse than a limit that is written down.

**What was built.** The rule asks of each CLAIM whether a resolver settles
it, and a resolver settles a claim in three shapes:

| shape | how the rule sees it |
|---|---|
| directly | the resolver is inside the claim's own scope and comes after it |
| through the success callback | the callback's CARRIER comes after the claim and sits in a block that encloses it |
| in a helper | the claim's function calls that helper, after the claim |

Each shape is a fixture, and each is proved by mutation: breaking the order,
the scope, the per-claim comparison, the carrier or the helper makes one
fixture fail, and none of the five survive.

**The measurement.** The rule is at least as strict on today's tree: every
file that passes the per-file rule still passes the per-claim rule, and the
per-claim rule catches the fixture the per-file rule misses (two claims, one
resolver — the file-level rule passed it, the claim-level rule reports the
claim the resolver does not reach).

**The limit that is left.** A resolver handed over by name —
`const onOk = async () => { … }` — is created by a statement of its own, and
the call that uses it cannot be found by walking up the source. The scan
reports the claim rather than counting a resolver it cannot place.

### Task 4 — the dead no-credential path in the fetch handler (P4)

`src/sse/handlers/fetch.js` has a no-credential branch that no fetch provider
can reach — the code says so itself ("kept for parity though no current fetch
provider sets noAuth"). It neither consults the breaker nor reports to it,
so it is outside the reach of the control, and the control document says so.

**The options.** Delete the branch, or close it the way the image path was
closed (consult and report).

**What the measurement changes.** The branch is unreachable, and not only by
the comment's claim:

- the ten providers with `noAuth: true` are coqui, devin-cli, edge-tts,
  google-tts, local-device, mimo-free, mmf, opencode, searxng and tortoise —
  and none of them has a `fetchConfig`;
- the six providers with a `fetchConfig` are exa, firecrawl, jina-reader,
  ollama, tavily and tinyfish — and none of them has `noAuth`;
- `AI_PROVIDERS` is built from static constants, so nothing can be added at
  runtime to make the branch reachable.

Closing it is not as cheap as it looks: the branch cannot run, so a test for
it has to mock the provider registry into a fiction, and the closing change
needs the `fetchLockKey` moved up and a direct `recordProviderFailure` call
added. Deleting it is nineteen lines and no test.

**The recommendation.** Leave it, and keep the declaration. The control
document already answers this question — "Stating it here is what keeps the
boundary a boundary rather than a hole" — and the branch is a deliberately
kept capability, not an oversight. Deleting a capability that somebody kept
on purpose is the maintainer's call, so it is a decision to be asked for
rather than a change to be made here.

---

## 4. The sweep result

Eighteen branches of the breaker's decision table were broken in turn, and
the suite was run after each one. The exit code is the verdict: a branch
that no test catches is a rule that nothing enforces.

| # | the branch | first run | after the work |
|---|---|---|---|
| A1 | a 499 is an abandoned request, not a provider failure | caught | caught |
| A2 | an abandoned request is counted | **not caught** | caught |
| A3 | a request that never reached the provider is recognised | caught | caught |
| A4 | a local failure releases the probe | caught | caught |
| A5 | a local failure is counted | caught | caught |
| A6 | a provider that answered resolves the half-open probe | caught | caught |
| A7 | a 4xx is not a provider-level failure | caught | caught |
| A8 | a burst of failures is one outage | caught | caught |
| A9 | a provider-level failure is recorded on the breaker | caught | caught |
| A10 | a transport error is a provider-level failure | **not caught** | caught |
| B1 | the lookup consults the breaker | caught | caught |
| B2 | an open circuit refuses the request | caught | caught |
| C1 | a provider that needs no credential gets a gate | caught | caught |
| D1 | the circuit opens when the threshold is reached | caught | caught |
| D2 | the probe is released | **not caught** | caught |
| E1 | a 5xx is a provider-level failure | caught | caught |
| E2 | an open circuit claims the probe when it half-opens | caught | caught |

**First run: three survivors.** Two were real gaps, and one was a test that
looked like it covered something and did not:

- **A2** — no test in the tree mentioned the abandoned-request counter.
- **A10** — the test said "transport error with no status" and called
  `recordDistinctFailures(3, undefined)`, but the helper had `status = 500`
  as a **default parameter**, so `undefined` became 500 and the test was a
  second copy of the 5xx test. The case was never exercised.
- **D2** — breaking the breaker's own `releaseProbe()` changed nothing the
  tests could see, because `probeStartedAt` is zeroed as well and the
  staleness check passes on its own. The check that sees the difference is
  `isAvailable()` — the pure availability check a health probe reads — and
  **no test called it at all**.

**After the work: no survivors.** Each of the three has a case that fails
when its branch is broken, and the eighteen were re-run to prove it.

The rule in the probe scan was swept the same way — five branches, five
fixtures, no survivors — and the xAI fix was swept the same way: two
mutations, both caught, and the restored file passes.

**How to reproduce.** The sweep mutates one branch at a time and runs the
focused breaker suite after each. The script is a throwaway, not a
repository script: the repository keeps the CASES, and a case is the thing
that stays useful. The proof that a case bites is made by breaking the
branch and watching the case fail.

---

## 5. What this phase does NOT do

- It does not change the breaker's semantics. The decision table is a
  contract, and this phase proves it rather than rewriting it.
- It does not touch the codex sign-in path.
- It does not add a provider flag. `noCredentialRequired` is an option on
  the lookup, because a registry flag changes the dashboard.
- It does not run the ESLint check — it does not run on the machine these
  changes are made on, and saying a check passed when it did not run is worse
  than saying it did not run.
