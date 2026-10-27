#!/usr/bin/env node
/**
 * KPI Report Generator
 *
 * Emits a KPI dashboard where every value has a named source. This is the whole
 * point: the previous version printed constants (a 434.9s test time, a "26
 * failures per run", an 85% documentation score) that no run had measured. A
 * dashboard of invented numbers is worse than no dashboard — it reads as
 * evidence while being none.
 *
 * Rules this file follows:
 *   - A value is either read from an artifact on disk, derived by a check run
 *     here, or reported as `not measured`. It is never assumed.
 *   - Anything that cannot be measured in this environment keeps its target and
 *     is marked `not measured` rather than defaulted to a passing number.
 *   - Exit code is 0 even with unmet KPIs: this is a report, not a gate. The
 *     gates are the individual checks (tests, mutation, ADR validation).
 *
 * Usage: node scripts/generate-kpi-report.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();

/** Read and parse JSON, returning null when absent or unparseable. */
function readJson(relPath) {
  const full = path.join(repoRoot, relPath);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return null;
  }
}

/** Run a node script, returning { ok, output } without throwing. */
function runScript(relPath) {
  try {
    const output = execFileSync(process.execPath, [path.join(repoRoot, relPath)], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { ok: true, output };
  } catch (error) {
    return { ok: false, output: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

// ---------------------------------------------------------------------------
// Measured KPIs
// ---------------------------------------------------------------------------

// Mutation score — the real number from the last gate run, not the target.
const mutationReport = readJson('reports/mutation/critical.json');
let mutation = { value: null, detail: 'no report — run npm run test:mutate:critical' };
if (mutationReport?.files) {
  let detected = 0;
  let total = 0;
  for (const data of Object.values(mutationReport.files)) {
    for (const m of data.mutants || []) {
      total += 1;
      if (m.status === 'Killed' || m.status === 'Timeout') detected += 1;
    }
  }
  if (total > 0) {
    const score = (detected / total) * 100;
    const breakAt = mutationReport.thresholds?.break ?? null;
    mutation = {
      value: score,
      detail: `${detected}/${total} mutants detected, break ${breakAt ?? 'n/a'}%`,
      status: breakAt === null || score >= breakAt ? 'green' : 'red',
    };
  }
}

// ADR register accuracy — derived by running the validator, not asserted.
const adr = runScript('scripts/validate-adrs.mjs');
let adrScore = { value: null, detail: 'validator failed to run' };
if (adr.output) {
  const match = adr.output.match(/(\d+) files checked, (\d+) issues found/);
  if (match) {
    const files = Number(match[1]);
    const issues = Number(match[2]);
    const perFileFields = 3;
    const accuracy = files === 0 ? 100 : Math.max(0, 100 - (issues / (files * perFileFields)) * 100);
    adrScore = {
      value: accuracy,
      detail: `${files} documents checked, ${issues} metadata issues`,
      status: issues === 0 ? 'green' : 'red',
    };
  }
}

// Guard test suite — count of tests in the security suites actually present.
let guardTests = { value: null, detail: 'suite files not found' };
const guardFiles = ['tests/unit/dashboard-guard.test.js', 'tests/unit/key-access.test.js'];
if (guardFiles.every((f) => fs.existsSync(path.join(repoRoot, f)))) {
  const counts = guardFiles.map((f) => {
    const body = fs.readFileSync(path.join(repoRoot, f), 'utf8');
    return (body.match(/^\s*it\(/gm) || []).length;
  });
  guardTests = {
    value: counts.reduce((a, b) => a + b, 0),
    detail: guardFiles.map((f, i) => `${path.basename(f)}: ${counts[i]}`).join(', '),
    status: 'green',
  };
}

// CI workflow inventory — count of parseable workflows.
let workflows = { value: null, detail: 'no workflows directory' };
const wfDir = path.join(repoRoot, '.github', 'workflows');
if (fs.existsSync(wfDir)) {
  const files = fs.readdirSync(wfDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  workflows = { value: files.length, detail: files.sort().join(', ') };
}

// Full-suite result — read from the artifact written by an actual `npx vitest
// run`. The suite takes ~6 minutes, far too long to run inside a report
// generator, so the measurement is taken deliberately and recorded; the report
// never guesses it.
const suite = readJson('reports/full-suite.json');
const suiteFailures = suite?.tests
  ? {
      value: suite.tests.failed,
      detail: `${suite.tests.failed} of ${suite.tests.total} tests failed (${suite.files.failed} of ${suite.files.total} files), taken ${suite.takenAt}`,
      status: suite.tests.failed === 0 ? 'green' : 'red',
    }
  : { value: null, detail: 'no reports/full-suite.json — run npx vitest run', status: 'gray' };
const suiteDuration = suite?.durationSeconds
  ? {
      value: suite.durationSeconds,
      // `durationSeconds` is the worst observed run, not the fastest: a warm
      // local cache must not read as a pass when CI runs cold every time.
      detail: `${suite.durationSeconds}s (wall ${suite.wallSeconds}s), taken ${suite.takenAt}${
        suite.durationNote ? ` — ${suite.durationNote}` : ''
      }`,
      status: suite.durationSeconds <= 300 ? 'green' : 'red',
    }
  : { value: null, detail: 'no reports/full-suite.json', status: 'gray' };

// Datadog's `dd-trace` is not used; tracing is OTLP. Report whether the export
// path has a verified endpoint configured, without inventing a score.
const tracingConfigured = Boolean(
  process.env.OTEL_ENABLED && process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const fmt = (v) => {
  if (v === null || v === undefined) return 'not measured';
  // Counts are integers; percentages keep two decimals. Formatting a count as
  // "67.00" reads as a measurement with false precision.
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
};

const rows = [
  {
    category: '**Test Suites**',
    kpi: 'Guard suite cases',
    target: 'all passing',
    current: fmt(guardTests.value),
    source: 'test file scan',
    status: guardTests.status || 'gray',
  },
  {
    category: '**Mutation Score**',
    kpi: 'Critical-path score',
    target: '≥ break threshold',
    current: mutation.value === null ? 'not measured' : `${fmt(mutation.value)}%`,
    source: mutation.detail,
    status: mutation.status || 'gray',
  },
  {
    category: '**Documentation**',
    kpi: 'ADR register accuracy',
    target: '100',
    current: adrScore.value === null ? 'not measured' : `${fmt(adrScore.value)}%`,
    source: adrScore.detail,
    status: adrScore.status || 'gray',
  },
  {
    category: '**Tracing**',
    kpi: 'OTLP export configured',
    target: 'per environment',
    current: tracingConfigured ? 'yes' : 'no (off)',
    source: 'OTEL_ENABLED + endpoint env',
    status: 'gray',
  },
  {
    category: '**Infra**',
    kpi: 'CI workflows',
    target: 'all parse',
    current: fmt(workflows.value),
    source: 'workflow file count',
    status: 'gray',
  },
  {
    category: '**Test Stability**',
    kpi: 'Failing tests per run',
    target: '0',
    current: fmt(suiteFailures.value),
    source: suiteFailures.detail,
    status: suiteFailures.status,
  },
  {
    category: '**Performance**',
    kpi: 'Full suite duration',
    target: '≤ 300s',
    current: suiteDuration.value === null ? 'not measured' : `${fmt(suiteDuration.value)}s`,
    source: suiteDuration.detail,
    status: suiteDuration.status,
  },
  {
    category: '**Build Reliability**',
    kpi: 'Build success rate',
    target: '100',
    current: 'not measured',
    source: 'needs CI history (API)',
    status: 'gray',
  },
  {
    category: '**Security**',
    kpi: 'Audit pass',
    target: 'pass',
    current: 'not measured',
    source: 'needs npm audit / CI history',
    status: 'gray',
  },
  {
    category: '**Accessibility**',
    kpi: 'WCAG compliance',
    target: 'AA',
    current: 'not measured',
    source: 'needs a11y audit',
    status: 'gray',
  },
];

const statusLabel = (s) =>
  s === 'green' ? '**🟢**' : s === 'red' ? '**🔴**' : s === 'yellow' ? '**🟡**' : '⚪';

console.log('# 9router KPI Report');
console.log('');
console.log(`*Generated: ${new Date().toISOString().slice(0, 10)}*`);
console.log('');
console.log('Every value below is read from an artifact or produced by a check run');
console.log('for this report. `not measured` means exactly that — it is not a pass.');
console.log('');
console.log('## Project Health KPIs');
console.log('');
console.log('| Category | KPI | Target | Current | Source | Status |');
console.log('|---|---|---|---|---|---|');
for (const row of rows) {
  console.log(
    `| ${row.category} | ${row.kpi} | ${row.target} | ${row.current} | ${row.source} | ${statusLabel(row.status)} |`,
  );
}
console.log('');
console.log('## Totals');
console.log('');
const measured = rows.filter((r) => r.current !== 'not measured').length;
console.log(`- KPIs with a measured value: ${measured}/${rows.length}`);
console.log(`- KPIs awaiting instrumentation: ${rows.length - measured}/${rows.length}`);
console.log('');
console.log('## Reproduce');
console.log('');
console.log('```bash');
console.log('npm run test:mutate:critical   # writes reports/mutation/critical.json');
console.log('node scripts/validate-adrs.mjs # ADR register metadata');
console.log('npm run verify:tracing         # OTLP export path');
console.log('node scripts/generate-kpi-report.mjs > kpi-report.md');
console.log('```');
