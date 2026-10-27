#!/usr/bin/env node
/**
 * Mutation score summary for the CI gate.
 *
 * Reads the Stryker JSON report written by stryker.critical.conf.js and prints
 * a markdown summary (to stdout) plus `score=<n>` to $GITHUB_OUTPUT so a later
 * step can badge the job without re-parsing the report.
 *
 * The score is computed here rather than scraped from Stryker's console table
 * because the table is formatted for humans and its column widths shift with
 * the numbers in it.
 *
 * Usage: node scripts/ci/mutation-summary.mjs [reportPath]
 */

import fs from 'node:fs';
import path from 'node:path';

const reportPath = process.argv[2] || 'reports/mutation/critical.json';

if (!fs.existsSync(reportPath)) {
  console.error(`::error::Mutation report not found at ${reportPath}`);
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const files = report.files || {};

const rows = [];
let killed = 0;
let survived = 0;
let noCoverage = 0;
let timeout = 0;
let compileError = 0;
let runtimeError = 0;

for (const [file, data] of Object.entries(files)) {
  const mutants = data.mutants || [];
  const counts = { killed: 0, survived: 0, noCoverage: 0, timeout: 0, error: 0 };
  for (const m of mutants) {
    if (m.status === 'Killed') counts.killed += 1;
    else if (m.status === 'Survived') counts.survived += 1;
    else if (m.status === 'NoCoverage') counts.noCoverage += 1;
    else if (m.status === 'Timeout') counts.timeout += 1;
    else if (m.status === 'CompileError') counts.error += 1;
    else if (m.status === 'RuntimeError') counts.error += 1;
  }
  killed += counts.killed;
  survived += counts.survived;
  noCoverage += counts.noCoverage;
  timeout += counts.timeout;
  compileError += counts.error;

  const total = counts.killed + counts.survived + counts.noCoverage + counts.timeout + counts.error;
  // Same definition Stryker uses: a mutant the suite did not detect counts
  // against the score whether it survived a weak assertion or was never run.
  const detected = counts.killed + counts.timeout;
  const score = total === 0 ? 0 : (detected / total) * 100;
  rows.push({
    file: file.replace(/\\/g, '/'),
    total,
    score,
    ...counts,
  });
}

const totalMutants = killed + survived + noCoverage + timeout + runtimeError;
const score = totalMutants === 0 ? 0 : ((killed + timeout) / totalMutants) * 100;

const breakThreshold = report.thresholds?.break ?? null;
const verdict =
  breakThreshold === null || score >= breakThreshold
    ? `✅ Pass — ${score.toFixed(2)}% ≥ break ${breakThreshold}%`
    : `❌ Fail — ${score.toFixed(2)}% < break ${breakThreshold}%`;

const lines = [];
lines.push('## 🧬 Mutation Testing — critical paths');
lines.push('');
lines.push(`**Score: ${score.toFixed(2)}%**  (break threshold ${breakThreshold ?? 'n/a'}%)`);
lines.push('');
lines.push(verdict);
lines.push('');
lines.push('| File | Mutants | Killed | Survived | No coverage | Score |');
lines.push('|---|---|---|---|---|---|');
for (const row of rows.sort((a, b) => a.score - b.score)) {
  lines.push(
    `| \`${row.file}\` | ${row.total} | ${row.killed} | ${row.survived} | ${row.noCoverage} | ${row.score.toFixed(2)}% |`,
  );
}
lines.push('');
lines.push(
  `Surviving mutants are the actionable list: each one is a behaviour no test pins. ` +
    `Open the uploaded \`mutation-report\` artifact for the exact lines.`,
);

const markdown = lines.join('\n');
console.log(markdown);

if (process.env.GITHUB_OUTPUT) {
  const out = process.env.GITHUB_OUTPUT;
  fs.appendFileSync(out, `score=${score.toFixed(2)}\n`);
  fs.appendFileSync(out, `survived=${survived}\n`);
  fs.appendFileSync(out, `no_coverage=${noCoverage}\n`);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');
}

// The gate itself is Stryker's exit code; this script only reports. Exit 0 so a
// failing score produces one clear red step rather than two.
void path;
process.exit(0);
