# Definition of Done - 9router Fork

## Overview
A comprehensive Definition of Done (DoD) that spans all quality dimensions: code, security, accessibility, performance, documentation, and infrastructure. Every code change must pass all applicable DoD checklists before merge.

---

## DoD - Code Quality Dimension

### General Code Requirements
- [ ] **All new/modified tests pass**: `npx vitest run` completes with no new failures
- [ ] **Import paths resolve correctly**: Tested from all affected directories (root, `tests/`, `tests/unit/`)
  - Verify: import paths with `@/` alias resolve to `src/`
  - Verify: relative imports work from test execution directory
- [ ] **Pattern matching logic verified**: 
  - Capabilities.js pattern order: specific before generic
  - `aggregateComboCapabilities` Math.min/max semantics are intentional and documented
  - No unintended pattern matching side effects
- [ ] **TTS provider compliance**:
  - No hardcoded `SPECIAL_ADAPTERS` lists in `ttsProviders/index.js`
  - All providers follow registry pattern with `ttsAdapter` field
  - `synthesizeViaConfig` uses module-level imports (no dynamic import inside function)
  - `handleTtsCore` has no hardcoded provider lists
- [ ] **Lint compliance**: `npx eslint .` exits 0 or 1 (with findings), never exits 2
- [ ] **Build succeeds**: `NEXT_TELEMETRY_DISABLED=1 npm run build` exits 0

### Specific Test File DoD

#### Import Path Resolution
- [ ] Test from `C:\9router-forked\fork` root: all `@/` aliases resolve
- [ ] Test from `C:\9router-forked\fork\tests` directory: all `@/` aliases resolve
- [ ] No "Cannot find module" errors in vitest collection phase
- [ ] If aliases fail from some directories, either:
  - Fix vitest config to resolve from correct `__dirname`, OR
  - Update test imports to use relative paths

#### Pattern Matching Tests (combo-caps-resolver.test.js)
- [ ] All 7 tests pass with correct expectations
- [ ] `contextWindow: 1_000_000` where `*glm-5.3*` pattern matches
- [ ] `contextWindow: 200_000` where only `*glm-5*` pattern matches
- [ ] Math.min logic for contextWindow is verified and documented
- [ ] Test comments accurately reflect actual pattern behavior

#### Security-Related Tests
- [ ] `dashboard-guard.test.js`: 24/24 passing
- [ ] `key-access.test.js`: 27/27 passing
- [ ] `/api/keys` returns 403 for non-loopback requests (with `requireLogin=false`)
- [ ] `/api/keys` returns 200 for loopback requests

---

## DoD - Security Dimension

### Authentication & Authorization
- [ ] `/api/keys` restricted to loopback-only via `LOCAL_ONLY_PATHS`
  - [ ] Non-loopback `GET /api/keys` returns 403 (even with `requireLogin=false`)
  - [ ] Loopback `GET /api/keys` returns 200
- [ ] `requireLogin=false` properly scoped to loopback requests only
  - [ ] Reuses existing `isLocalRequest` machinery
  - [ ] Remote requests always go through auth table regardless of setting
- [ ] API keys are never exposed in plaintext to remote callers
  - [ ] Keys masked in logs/output
  - [ ] Validation uses exact-match lookup (`WHERE key = ?`)
  - [ ] No key leakage through error messages or debug endpoints

### SSRF Protection
- [ ] Provider-node `baseUrl` has SSRF guard at execution time
  - [ ] `assertPublicUrlResolved` applied for non-local nodes
  - [ ] `local: true` flag only set when node created by loopback caller
  - [ ] Ollama/self-hosted nodes still work from loopback
- [ ] `/api/provider-nodes/validate` applies guard based on caller origin
- [ ] DNS rebinding attack mitigated (per-hop redirect validation)

### API Key & Credential Handling
- [ ] API keys stored with proper scoping (models/combos)
  - [ ] `keyAccess.js` enforces per-key model/combo restrictions
  - [ ] No global key access without model/combo specification
- [ ] Credential selection under module-level promise mutex
  - [ ] No race conditions in concurrent credential lookup
  - [ ] Sticky-round-robin path consistent with mutex
- [ ] Sensitive headers stripped before persistence
  - [ ] `authorization`, `cookie`, `token`, `api-key` removed from `requestDetails`
  - [ ] Headers sanitized in `sanitizeHeaders()` function

### Observability & Data Retention
- [ ] `usageRetentionDays` default 90 days with daily prune function
  - [ ] `pruneUsageHistory()` executes and removes old rows
  - [ ] `usageDaily` rollup remains correct after pruning
  - [ ] VACUUM recommended for sql.js adapter databases
- [ ] `requestDetails` trimmed to 200 records max
  - [ ] 5 KB per field truncation applied
  - [ ] Headers scrubbed before persistence
- [ ] Observability enabled by default but documentable as off
  - [ ] `OBSERVABILITY_ENABLED !== "false"` triggers recording
  - [ ] Setting to disable announced in settings UI

---

## DoD - Accessibility Dimension

### WAI-ARIA Compliance
- [ ] Modals have appropriate `aria-modal="true"`
- [ ] Modeless dialogs have `role="dialog"` with `aria-labelledby`
- [ ] Focus traps present in modal dialogs with `aria-hidden` management
- [ ] Escape key closes modals with `Esc` keymapping
- [ ] Focus returns to opening element after modal close

### Color & Contrast
- [ ] Focus-visible styles present in `globals.css` or equivalent
- [ ] Focus outline meets WCAG AA contrast ratio (minimum 3:1)
- [ ] Non-text contrast meets WCAG standards
- [ ] Color is not the only means of conveying information

### Keyboard Navigation
- [ ] All interactive elements reachable via Tab key
- [ ] Focus order is logical and persistent
- [ ] Skip links present for main content navigation
- [ ] Modals trap focus appropriately

### Landmark Roles
- [ ] Page has `role="main"` or appropriate landmark roles
- [ ] Navigation has `role="navigation"`
- [ ] Complementary content has `role="complementary"`
- [ ] Search functionality has `role="search"` when present

---

## DoD - Performance Dimension

### Core Web Vitals
- [ ] **LCP (Largest Contentful Paint)**: < 2.5s (measure with Lighthouse)
  - [ ] Font loading timeout ≤ 500ms
  - [ ] Preconnect to `fonts.gstatic.com` present in layout
  - [ ] No unoptimized images as LCP elements
- [ ] **FCP (First Contentful Paint)**: < 2.0s (measure with Lighthouse)
  - [ ] Font timeout reduction from 1s to 500ms verified
  - [ ] No blocking scripts in head
- [ ] **INP (Interaction to Next Paint)**: < 400ms (measure with Lighthouse)
  - [ ] Event listener count reasonable
  - [ ] Abort signal forwarded upstream (PERF-05)
- [ ] **CLS (Cumulative Layout Shift)**: < 0.1 (measure with Lighthouse)
  - [ ] Image dimensions specified
  - [ ] Font size transitions not causing shift

### Runtime Performance
- [ ] **Mutex contention verified**: 
  - [ ] Throughput measurement at concurrency 1, 8, 32, 128
  - [ ] If bottleneck identified, critical section shrink target documented
- [ ] **Settings cache**: 1-2s cache with explicit invalidation
  - [ ] `getSettings()` not called excessively per request
  - [ ] Cache invalidation on `updateSettings`
- [ ] **Request body limit**: 128 MB with no OOM on normal usage
  - [ ] No concurrent uploads exhaust memory
  - [ ] Lower bounds documented if changed
- [ ] **Tunnel enable**: Returns `status: "starting"` immediately, UI polls status
  - [ ] No 8s blocking delay in request path
  - [ ] `/api/tunnel/status` polls successfully

### Resource Limits
- [ ] Metrics series bounded: 500 per map, overflow counted as error
- [ ] Latency histogram: 12 fixed buckets
- [ ] Request details: 200 records, 5 KB per field
- [ ] Proxy dispatcher cache: size-capped
- [ ] DNS cache: TTL present and functional

---

## DoD - Documentation Dimension

### Document Hygiene
- [ ] **Roadmap updated**: Current phase/step reflected in `COMPREHENSIVE_ROADMAP.md`
- [ ] **ADR register up to date**: 
  - [ ] All ADRs have correct status field
  - [ ] `last-reviewed` date present on each ADR
  - [ ] `supersedes` field where applicable
  - [ ] Invalid JSON artifacts removed or fixed (E-27)
- [ ] **Evidence ledger complete**:
  - [ ] All claims in audit have MEASURED/CODE-VERIFIED label
  - [ ] No UNKNOWN/BLOCKED entries without justification
  - [ ] Evidence commands recorded and runnable
- [ ] **CHANGELOG.md reflects current version**
  - [ ] Latest version entry present
  - [ ] All significant changes documented
  - [ ] No unreleased changes missing
- [ ] **STATUS_UPDATE.md reflects current state**
  - [ ] Completed fixes listed
  - [ ] Remaining issues documented
  - [ ] Current test results recorded

### DoD - Documentation Checklist
- [ ] Roadmap: phase and step current
- [ ] ADR register: all statuses correct and verified
- [ ] Evidence ledger: all claims justifiable
- [ ] CHANGELOG: version-accurate
- [ ] STATUS_UPDATE: state-accurate
- [ ] No stale TODOs in code (or all tagged with issue reference)
- [ ] Comments accurately reflect behavior (no outdated comments)

---

## DoD - Infrastructure Dimension

### CI/CD Pipeline
- [ ] `drift-prevention.yml` runs on every PR and push to master
- [ ] `chaos-engineering.yml` runs weekly (Sunday 03:17 UTC)
- [ ] `docker-publish.yml` builds and tags on `v*` tags
- [ ] `dependabot.yml` fixed (no corrupted config)
- [ ] Concurrency groups prevent CI stampede
- [ ] All workflows use `npm ci` or have lockfile guarantee

### Test Infrastructure
- [ ] Vitest config resolves `@/` aliases from all directories
  - [ ] OR relative paths updated in affected test files
- [ ] Chaos suite deterministic and network-free
- [ ] Max concurrency set appropriately (60 for unit tests)
- [ ] Chaos suite excluded from default run (exec explicitly)
- [ ] All test files in `tests/**/*.test.js` collectable

### Build & Deployment
- [ ] Production build: `NEXT_TELEMETRY_DISABLED=1 npm run build` exits 0
- [ ] Standalone output generated correctly
- [ ] Assets copied to `.next/static/chunks/`
- [ ] No missing bindings for `better-sqlite3` (or graceful fallback)
- [ ] Docker image builds on `v*` tags (if `docker-publish.yml` active)

### Environment & Configuration
- [ ] `package-lock.json` committed (removed from `.gitignore`)
- [ ] No optional dependency failures blocking install
- [ ] Engine requirements pinned or documented
- [ ] Environment variables documented (`.env.example` up to date)
- [ ] No secrets in project files or git history

---

## DoD Gate Classification

### Gates are evaluated in order; a failure at any gate blocks merge:

| Gate | Pass Condition | Block If Fails |
|---|---|---|
| **Code Quality** | All tests pass, lint exits 0/1, build succeeds | ✅ |
| **Security** | `/api/keys` loopback-only, SSRF guards, no key exposure | ✅ |
| **Accessibility** | WAI-ARIA, focus-visible, color contrast | 🟡 Warning only (blocker for v1.0) |
| **Performance** | Core Web Vitals within targets, mutex verified | 🟡 Warning only |
| **Documentation** | Roadmap, ADR, CHANGELOG, STATUS_UPDATE current | ✅ |
| **Infrastructure** | CI passes, build works, env consistent | ✅ |

**Final Decision**: If all ✅ gates pass → merge.  
If 🟡 warnings only → merge with documentation task created for later.  
If any ✅ gate fails → block merge and fix.

---

## DoD Enforcement

### CI Integration
```
npx node scripts/doD-check.mjs
```
Runs on every PR. Outputs:
- Pass/fail per dimension
- Specific failures with file/line references
- DoD grade (A/B/C/D)

### PR Review Checklist
Reviewers must verify:
- [ ] DoD checklist applicable to change is satisfied
- [ ] No regression in existing test suite
- [ ] Security implications reviewed
- [ ] Performance impact assessed
- [ ] Documentation updated if needed
- [ ] ADR created if new architectural decision

### Consequences
- **DoD A grade**: Merge immediately
- **DoD B grade**: Merge with accompanying task to address remaining items
- **DoD C/D grade**: Block merge, create detailed fix plan
- **Repeated failures**: Escalate to team lead for process review

---
*Definition of DoD last updated: 2026-10-27*
*Current version: 1.0*
*Applies to all merges into master branch*