// Stryker Mutation Testing Configuration — critical paths (CI gate)
// https://stryker-mutator.io/docs/stryker-js/configuration/
//
// This config is the one the CI gate runs. It is deliberately narrower than
// stryker.conf.js (which targets all of `src/**`): the gate has to finish
// inside a job timeout and its score has to be stable enough to fail a PR on.
// A whole-tree run takes far too long and its score moves whenever unrelated
// code gains or loses a test.
//
// Scope: the two modules whose suites are verified green in this repository —
// the dashboard session guard and the per-API-key access engine. Both are
// security-relevant: a surviving mutant in either is a silent authorization
// bypass, which is exactly what this gate exists to catch.
//
// Run locally with:  npm run test:mutate:critical
module.exports = {
  testRunner: 'vitest',

  // Critical-path production code only.
  mutate: [
    'src/dashboardGuard.js',
    'src/sse/services/keyAccess.js',
  ],

  // Only the suites that actually exercise the files above. Handing the runner
  // the whole tests/ tree would mutate-and-run unrelated suites for every
  // mutant and blow the job timeout.
  testFiles: [
    'tests/unit/dashboard-guard.test.js',
    'tests/unit/key-access.test.js',
  ],

  plugins: ['@stryker-mutator/vitest-runner'],

  checkers: [],

  // `json` is what the workflow parses for the score; `clear-text` is for the
  // operator reading the log; `html` is uploaded as an artifact for triage.
  reporters: ['clear-text', 'json', 'html'],
  jsonReporter: { fileName: 'reports/mutation/critical.json' },
  htmlReporter: { fileName: 'reports/mutation/critical.html' },

  // The fail gate. `break` is the hard floor: a score below it fails the job
  // (non-zero exit) instead of only colouring the report.
  //
  // These values come from a measured run, not from aspiration. A gate set to
  // the target (80) rather than to reality is red on a healthy tree, which
  // trains everyone to ignore it; a gate set generously low never fires.
  //
  // Measured baseline (2026-10-27, this config):
  //   all files        64.22%  (332 killed, 153 survived, 32 no-coverage)
  //   dashboardGuard   62.11%  (218 killed, 108 survived, 25 no-coverage)
  //   keyAccess        68.67%  (114 killed,  45 survived,  7 no-coverage)
  //
  // 60 is ~4 points under the measured score: enough headroom that ordinary
  // churn does not produce a spurious red, tight enough that a real regression
  // (20+ newly surviving mutants) fails the PR.
  //
  // This is a ratchet, not a target. Raise `break` to the new measured score
  // whenever the score improves, and never lower it to make a red build green —
  // lowering the floor is the one change that makes this gate meaningless.
  thresholds: {
    high: 80,
    low: 64,
    break: 60,
  },

  // Deterministic ordering and no incremental cache: the gate must score the
  // same tree the same way on every run.
  incremental: false,
  concurrency: 2,
  timeoutMS: 20000,

  logLevel: 'info',
};
