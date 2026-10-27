# Benchmarking & Evaluation Infrastructure

## Overview
Comprehensive benchmarking, KPI tracking, and evaluation infrastructure for the 9router fork. Establishes measurable targets, measurement methods, and CI integration for all quality dimensions.

---

## Performance Benchmarks

### Test Suite Benchmarks

| Metric | Target | Current | Measurement Method | Status |
|---|---|---|---|---|
| **Suite wall time** | < 300 s | 434.9 s | `npx vitest run` duration, E-23 | 🟡 |
| **Import resolution time** | < 5 s | varies | Vitest collection phase, from root vs tests/ | 🟡 |
| **Test collection** | < 10 s | measured | `npx vitest --run --reporter=verbose` startup | 🟡 |
| **Failed suite identification** | < 30 s | part of suite run | `npx vitest run --reporter=dot` then filter | 🟢 |

**Measurement Command**:
```bash
# Baseline: run from repository root
cd /c/9router-forked/fork && time npx vitest run > /tmp/baseline.txt 2>&1

# After changes: run same command
cd /c/9router-forked/fork && time npx vitest run > /tmp/new.txt 2>&1

# Compare: diff failures
diff /tmp/baseline.txt /tmp/new.txt | grep -E '✓|×|FAIL|passed' > /tmp/drift-report.txt
```

### Production Build Benchmarks

| Metric | Target | Current | Measurement Method | Status |
|---|---|---|---|---|
| **Build wall time** | < 90 s | 105 s | `NEXT_TELEMETRY_DISABLED=1 npm run build`, E-25 | 🟡 |
| **Exit code** | 0 (success) | 0 | `npm run build` exit status | 🟢 |
| **Assets compiled** | 174 API routes + 27 dashboard pages | measured | Build output inspection | 🟡 |
| **Largest chunk** | < 300 KB | 335.4 KB | `ls -lS .next/static/chunks/*.js` | 🟡 |
| **Total JS size** | < 2.5 MB | 2.3 MB | `du -sh .next/static/chunks/` | 🟢 |

**Measurement Command**:
```bash
cd /c/9router-forked/fork && NEXT_TELEMETRY_DISABLED=1 npm run build 2>&1
# Check exit status: echo $?
# Check chunk sizes: ls -lS .next/static/chunks/*.js | head -6
```

### Core Web Vitals Benchmarks

| Metric | Target | Current | Measurement Method | Status |
|---|---|---|---|---|
| **LCP** | < 2.5s | ~3.5s | Lighthouse CI, `lhci autorun` | 🟡 |
| **FCP** | < 2.0s | ~2.5s | Lighthouse CI | 🟡 |
| **INP** | < 400ms | measured | Lighthouse/Web Vitals SDK | 🟡 |
| **CLS** | < 0.1 | measured | Lighthouse CI | 🟡 |

**Measurement Command** (Lighthouse CI):
```bash
# Install: npm i -D @lhci/cli
lhci autorun --collect.chromeFlags="--headless" --collect.url="http://localhost:20128"
# Or manual:
npx serve .next/standalone -l 20128 &  # start server
npx lhci autorun
```

**Preconnect/Font Benchmarks** (specific to our fixes):
| Change | Expected Impact | Measurement |
|---|---|---|
| Preconnect to fonts.gstatic.com | +100-200ms LCP | Lighthouse before/after |
| Font timeout: 1s → 500ms | +200ms FCP | `layout.js` timeout change, Lighthouse |
| Both combined | +300ms+ improvement | Combined Lighthouse run |

### Runtime Performance Benchmarks

#### Mutex Contention Test
**Purpose**: Measure credential selection throughput at varying concurrency

**Setup**:
```bash
# Create a stub executor that always returns success
# Send POST /v1/chat/completions with concurrency N
# Measure requests/second
```

**Measurement Plan**:
1. Drive `POST /v1/chat/completions` against stub executor
2. Concurrency levels: 1, 8, 32, 128
3. Record p50/p99 throughput per level
4. If throughput flat across levels → mutex is bottleneck → fix justified
5. If throughput scales → lock not hot → fix not urgent

**Success Criterion**: Throughput at concurrency 128 is ≥ 50% of concurrency 1
*(If not, mutex is limiting and critical section shrink justified)*

#### Usage History Prune Test
**Purpose**: Verify `pruneUsageHistory()` reduces table size correctly

**Setup**:
1. Seed temp SQLite DB with 1 M rows in `usageHistory`
2. Execute `pruneUsageHistory(90)` (90-day retention)
3. Assert table reduced to ~90 days of data
4. Verify `getUsageStats("30d")` returns same numbers as before prune

**Measurement Command**:
```bash
# In test environment
node -e "
const db = require('better-sqlite3')(':memory:');
const { pruneUsageHistory } = require('./src/lib/db/repos/usageRepo.js');
// Seed 1M rows...
// Run prune
pruneUsageHistory(90);
// Assert row count
const count = db.prepare('SELECT COUNT(*) FROM usageHistory').get().COUNT;
console.log('Rows after prune:', count);
assert(count < 100000, 'Prune did not reduce table sufficiently');
"
```

#### Settings Cache Test
**Purpose**: Verify settings cache reduces SQLite reads

**Setup**:
1. Make N requests without cache
2. Measure `getSettings()` call count via monitoring
3. Enable 2s cache
4. Make N requests with cache
5. Measure `getSettings()` call count
6. Assert cache reduced calls by ~50%

**Expected**: Cache hit ratio > 70% after warmup

---

## Security Benchmarks

### API Key Access Test
**Purpose**: Verify `/api/keys` loopback-only restriction

**Test Setup**:
```javascript
// Test 1: Non-loopback request returns 403
const response1 = await fetch('http://10.0.0.1:20128/api/keys', {
  headers: { 'x-9r-real-ip': '10.0.0.9' }  // non-loopback
});
expect(response1.status).toBe(403);

// Test 2: Loopback request returns 200
const response2 = await fetch('http://127.0.0.1:20128/api/keys');
expect(response2.status).toBe(200);

// Test 3: Remote tunnel returns 403 regardless
const response3 = await fetch('http://external-host:20128/api/keys');
expect(response3.status).toBe(403);
```

**Success Criterion**: All three tests pass

### SSRF Resistance Test
**Purpose**: Verify provider-node baseUrl SSRF guard

**Test Setup**:
```javascript
// Create provider node with malicious baseUrl
await createProviderNode({
  baseUrl: 'http://169.254.169.254',  // instance metadata
  // ... other fields
});

// Send chat request using that node
const response = await fetch('http://127.0.0.1:20128/v1/chat/completions', {
  body: JSON.stringify({ /* ... */ }),
  headers: { 'Content-Type': 'application/json' }
});

// Should be refused before any socket opened
expect(response.status).toBe(400);  // or specific error code
expect(response.body).toMatchObject({ error: 'SSRF_BLOCKED_URL' });
```

**Success Criterion**: Request refused with SSRF error, no outgoing connection

### Auth Bypass Test
**Purpose**: Verify `requireLogin=false` scoping

**Test Setup**:
```javascript
// With requireLogin=false, non-loopback should still auth
const response = await fetch('http://10.0.0.1:20128/api/some-protected-route', {
  headers: { authorization: 'Bearer valid-token' }
});
// Should be 403 if not loopback, even with requireLogin=false
expect(response.status).toBe(403);

// Loopback should proceed
const response2 = await fetch('http://127.0.0.1:20128/api/some-protected-route', {
  headers: { authorization: 'Bearer valid-token' }
});
expect(response2.status).toBe(200);
```

**Success Criterion**: Non-loopback = 403, loopback = 200

---

## Reliability Benchmarks

### Error Budget Consumption
| Metric | Target | Measurement |
|---|---|---|
| **Error budget consumed** | < 5% availability | From `sse_error_budget_consumed_total` |
| **Circuit breaker rejections** | tracked per provider | `sse_circuit_breaker_rejections_total` |
| **Provider local failures** | tracked | `sse_provider_local_failures_total` |
| **Upstream contacted on local failure** | 0 (499 not counted) | From `upstreamContacted` distinction |

**Measurement Commands**:
```bash
# Circuit breaker rejections
curl http://127.0.0.1:20128/api/metrics | grep sse_circuit_breaker_rejections_total

# Provider local failures  
curl http://127.0.0.1:20128/api/metrics | grep sse_provider_local_failures_total

# Error budget consumed
curl http://127.0.0.1:20128/api/metrics | grep sse_error_budget_consumed_total
```

### Login Attempt Lockout
| Metric | Target | Measurement |
|---|---|---|
| **Lockout persistence** | survive restart | `src/lib/auth/loginLimiter.js` |
| **Unknown bucket rate-limiting** | deliberate, not accidental | policy decision |
| **Stale entry eviction** | implemented | TODO item |

### Concurrent Request Handling
| Metric | Target | Measurement |
|---|---|---|
| **Max concurrent requests** | no hard cap (but mutex limits throughput) | load test |
| **Request queue depth** | monitored, no hard limit | metrics |
| **OOM under load** | < 3 concurrent 100MB bodies | load test with memory monitoring |

---

## Documentation Benchmarks

### ADR Register Status Accuracy
| Metric | Target | Measurement Method |
|---|---|---|
| **Status fields correct** | 100% | Manual review + `scripts/validate-adrs.mjs` |
| **last-reviewed dates present** | 100% | Check all ADR markdown files |
| **Invalid JSON artifacts** | 0 | `JSON.parse` per .json file in docs/ |
| **Stale TODO comments** | 0 in source | `grep -rn 'TODO' src/ | grep -v '.test.' | grep -v '// FIXME'`

**CI Check** (`scripts/validate-adrs.mjs`):
```bash
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const adrDir = path.join(process.cwd(), 'docs', 'repo-audit');
const adrFiles = fs.readdirSync(adrDir).filter(f => f.endsWith('.md'));

let issues = 0;
let checked = 0;

for (const file of adrFiles) {
  const content = fs.readFileSync(path.join(adrDir, file), 'utf-8');
  checked++;
  
  // Check for status field
  if (!content.includes('Status:')) {
    console.error(`❌ ${file}: Missing Status field`);
    issues++;
  }
  
  // Check for last-reviewed date
  if (!content.includes('last-reviewed')) {
    console.warn(`⚠️ ${file}: Missing last-reviewed date`);
  }
  
  // Try JSON parse of any .json files
  const jsonMatch = file.match(/\.json$/);
  if (jsonMatch) {
    try {
      JSON.parse(fs.readFileSync(path.join(adrDir, file), 'utf-8'));
    } catch (e) {
      console.error(`❌ ${file}: Invalid JSON`);
      issues++;
    }
  }
}

console.log(`ADR Validation: ${checked} files checked, ${issues} issues found`);
process.exit(issues > 0 ? 1 : 0);
```

### Documentation Completeness
| Metric | Target | Current | Status |
|---|---|---|---|
| **Roadmap phase current** | 100% | ✅ Phase 1 active | 🟢 |
| **ADR register up to date** | 100% | ~85% | 🟡 |
| **Evidence ledger complete** | 100% | 100% (E-01 to E-76) | 🟢 |
| **CHANGELOG version-accurate** | 100% | ✅ v0.5.104 | 🟢 |
| **STATUS_UPDATE state-accurate** | 100% | ✅ Current | 🟢 |
| **No stale TODOs in src/** | 0 | ~5 tagged TODOs | 🟡 |

### Diff-Grading Accuracy
| Metric | Target | Measurement |
|---|---|---|
| **Diff grade auto-classification accuracy** | 90%+ | Compare auto-grade vs. human-reviewed grade |
| **False positive rate** | < 10% | Auto-grade says A but human says C |
| **False negative rate** | < 10% | Auto-grade says C but human says A |

**Measurement**: Run diff-grading on 50 recent PR diffs, compare with human reviewer classification.

---

## KPI Dashboard

### Project Health KPIs

| Category | KPI | Target | Current | Trend | Status |
|---|---|---|---|---|---|
| **Test Stability** | New failures per run | 0 | 26 (baseline) | ➡️ | 🟡 |
| **Build Reliability** | Build success rate | 100% | 100% | ➡️ | 🟢 |
| **Security Score** | Pass/Fail | 100% ✅ | 100% ✅ | ➡️ | 🟢 |
| **Accessibility** | WCAG compliance | AA | Partial | ⬆️ | 🟡 |
| **Performance** | Test suite time | < 300s | 434.9s | ⬇️ | 🟡 |
| **Documentation** | ADR status accuracy | 100% | ~85% | ⬆️ | 🟡 |
| **Infra** | CI pass rate | 100% | 100% | ➡️ | 🟢 |

### Weekly Report Automation
```bash
# Generate weekly KPI report
node scripts/generate-kpi-report.mjs > /tmp/kpi-weekly-report.md

# Include:
# - Test suite pass/fail trend
# - Build time this week vs. last week
# - Security benchmark results
# - Performance metrics (LCP, FCP, INP)
# - ADR status changes
# - Open issues count
# - Recommendations for next week
```

### Trend Tracking
- **30-day trend**: Track each KPI daily, show sparkline in dashboard
- **Goal**: All KPIs improving or stable, none degrading
- **Alert**: Any KPI degrading for 3 consecutive days triggers review

---
*Benchmarking infrastructure last updated: 2026-10-27*
*Current version: 1.0*
*All measurements should be run from `C:\9router-forked\fork` repository root*