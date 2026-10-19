/**
 * The drift workflow's own contract.
 *
 * This workflow is the repository's only `pull_request:` trigger, so
 * anything it gets wrong is invisible: a pull request that the path filter
 * excludes runs no CI at all, a knob the operator sets never reaches the
 * gate, and a summary that reports "0 tests" hides both.
 *
 * These tests read the workflow file itself rather than a copy of it, so
 * they fail when the workflow changes — which is the only way a contract
 * about a file stays true.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_PATH = resolve(ROOT, ".github/workflows/drift-prevention.yml");
const WORKFLOW = readFileSync(WORKFLOW_PATH, "utf8");
const GATE_SCRIPT = readFileSync(resolve(ROOT, "scripts/ci/validate-slo.mjs"), "utf8");
const DOCS = readFileSync(resolve(ROOT, "PRODUCTION_READINESS_CONTROLS.md"), "utf8");

/**
 * The `paths:` list of the pull_request trigger.
 */
function pathPatterns() {
  const lines = WORKFLOW.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s{4}paths:\s*$/.test(l));
  expect(start, "the workflow must have a pull_request paths filter").toBeGreaterThan(-1);

  const patterns = [];
  for (const line of lines.slice(start + 1)) {
    // The list carries comments between its entries.
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    if (trimmed === "") continue;
    const m = trimmed.match(/^-\s*'([^']+)'\s*$/);
    if (!m) break;
    patterns.push(m[1]);
  }
  return patterns;
}

/**
 * An approximation of the way GitHub matches a path filter.
 *
 * It is only used to catch a MISSING entry, so a pattern that is too
 * generous is harmless here — every pattern in the list is anchored at the
 * repository root, and the assertions below name the file that must be
 * covered.
 */
function toRegExp(pattern) {
  // `**` has to be replaced BEFORE the single `*`, or the `.*` it becomes
  // is then rewritten by the single-star rule.
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${source}$`);
}

function isCovered(file) {
  return pathPatterns().some((pattern) => toRegExp(pattern).test(file));
}

describe("the drift workflow: the pull_request path filter", () => {
  it("covers the control plane's own files", () => {
    // A pull request that touches only one of these used to run no CI at
    // all: this is the only workflow in the repository with a
    // `pull_request:` trigger.
    const mustRun = [
      "package.json",
      ".gitattributes",
      "PRODUCTION_READINESS_CONTROLS.md",
      "SRE_ADR.md",
      "docs/ARCHITECTURE.md",
      ".github/workflows/drift-prevention.yml",
      ".github/workflows/chaos-engineering.yml",
      "scripts/ci/validate-slo.mjs",
      "src/sse/services/metrics.js",
      "src/sse/services/auth.js",
      "open-sse/services/circuitBreaker.js",
      "open-sse/config/runtimeConfig.js",
      "tests/unit/slo-gate.test.js",
    ];
    for (const file of mustRun) {
      expect(isCovered(file), `${file} must trigger the drift gate`).toBe(true);
    }
  });

  it("covers the whole workflow directory, not one file of it", () => {
    // Another workflow can change this one — or be changed to disable it.
    expect(pathPatterns()).toContain(".github/workflows/**");
  });

  it("still covers the whole source tree rather than an enumeration of it", () => {
    // The list cannot stay correct if it is maintained by hand.
    for (const dir of ["src/**", "open-sse/**", "tests/**", "scripts/**"]) {
      expect(pathPatterns()).toContain(dir);
    }
  });
});

describe("the drift workflow: the knobs it forwards to the SLO gate", () => {
  /**
   * The knobs in the documented operator table.
   *
   * The table is the contract: it says what an operator may set. A knob in
   * the table that the workflow does not forward is a knob the operator can
   * set and never see take effect — the script's own default takes its
   * place, silently.
   */
  function documentedKnobs() {
    const lines = DOCS.split(/\r?\n/);
    // The cell has to BE the knob: another table in the document has a row
    // whose first cell starts with the same name.
    const anchor = lines.findIndex((l) => /^\|\s*`SLO_METRICS_ENDPOINT`\s*\|/.test(l));
    expect(anchor, "the controls document must have the gate's configuration table").toBeGreaterThan(-1);

    // The table around that row — not every table in the document.
    let start = anchor;
    while (start > 0 && /^\|/.test(lines[start - 1])) start -= 1;
    let end = anchor;
    while (end + 1 < lines.length && /^\|/.test(lines[end + 1])) end += 1;

    const knobs = [];
    for (let i = start; i <= end; i += 1) {
      const m = lines[i].match(/^\|\s*`([A-Z_]+)`\s*\|/);
      if (m) knobs.push(m[1]);
    }
    return knobs;
  }

  it("forwards every knob the controls document lists", () => {
    const knobs = documentedKnobs();
    expect(knobs.length).toBeGreaterThan(10);

    for (const knob of knobs) {
      // The endpoint is a secret, the rest are repository variables; what
      // matters is that the name reaches the gate's environment.
      expect(WORKFLOW, `${knob} must be passed to the SLO gate`).toContain(`${knob}:`);
    }
  });

  it("forwards the knobs as repository variables, not as literals", () => {
    // A literal cannot be changed by an operator without a commit to this
    // repository — and the knobs in the table exist to be changed.
    for (const knob of [
      "SLO_REQUIRE_FULL_WINDOW",
      "SLO_MIN_SAMPLE_SECONDS",
      "SLO_TARGET_ERROR_RATE",
      "SLO_MAX_REDIRECTS",
      "SLO_FETCH_TIMEOUT_MS",
    ]) {
      expect(WORKFLOW, `${knob} must come from a repository variable`).toContain(
        `${knob}: \${{ vars.${knob} }}`,
      );
    }
  });

  it("forwards a knob the gate script reads", () => {
    // The two that were documented but never forwarded.
    const readByTheScript = [
      ...GATE_SCRIPT.matchAll(/(?:process\.env\.|numEnv\(\s*"|env\(\s*")([A-Z][A-Z0-9_]*)/g),
    ].map((m) => m[1]);

    for (const knob of ["SLO_REQUIRE_FULL_WINDOW", "SLO_MIN_SAMPLE_SECONDS"]) {
      expect(readByTheScript, `the gate script must read ${knob}`).toContain(knob);
    }
  });

  it("forwards the knobs that are already forwarded", () => {
    // The ones that work today must keep working.
    for (const knob of ["SLO_GATE_SKIP", "SLO_GATE_OVERRIDE_APPROVED", "SLO_GATE_OVERRIDE_REASON"]) {
      expect(WORKFLOW).toContain(`${knob}: \${{ vars.${knob} }}`);
    }
  });
});

describe("the drift workflow: the summary it prints", () => {
  /**
   * The pattern the workflow extracts the passed count with, taken OUT of
   * the workflow so this test breaks when the pattern changes.
   */
  function passedCountPattern(variable) {
    const line = WORKFLOW.split(/\r?\n/).find((l) => l.includes(variable));
    expect(line, `the workflow must compute ${variable}`).toBeTruthy();
    const m = line.match(/grep -oE '([^']+)'/);
    return m ? m[1] : null;
  }

  it("reads the passed count out of a real vitest summary line", () => {
    // vitest prints TWO spaces, and in a failing run the passed count is
    // the SECOND field, not the one next to the word "Tests". The pattern
    // that asked for exactly one space never matched anything, so every
    // run reported "Tests 0 passed" and the fallback hid it.
    const pattern = passedCountPattern("BASELINE_PASSED=");
    expect(pattern, "the summary must extract the passed count with a pattern").toBeTruthy();

    const summary = "      Tests  82 failed | 3760 passed | 14 expected fail | 110 skipped | 1 todo (3967)";
    expect(summary.match(new RegExp(pattern))?.[0]).toBe("3760 passed");
  });

  it("reads the passed count out of a green summary line too", () => {
    const pattern = passedCountPattern("NEW_PASSED=");
    expect(pattern).toBeTruthy();
    const summary = "      Tests  3760 passed (3760)";
    expect(summary.match(new RegExp(pattern))?.[0]).toBe("3760 passed");
  });

  it("does not use the one-space pattern that never matched", () => {
    expect(WORKFLOW).not.toContain("grep -o 'Tests [0-9]* passed'");
  });

  it("does not print the unit twice", () => {
    // The extraction yields "3760 passed" and the echo adds its own "passed".
    // Without a reduction in between, CI printed
    //   Baseline: Tests 3415 passed passed
    // — which is how the first run with the fixed pattern turned out.
    const pattern = passedCountPattern("BASELINE_PASSED=");
    const summary = "      Tests  82 failed | 3760 passed | 14 expected fail | 110 skipped | 1 todo (3967)";
    const matched = summary.match(new RegExp(pattern))?.[0];
    expect(matched).toBe("3760 passed");

    // The match is reduced to the bare number...
    const extract = WORKFLOW.split(/\r?\n/).find((l) => l.includes("BASELINE_PASSED="));
    expect(extract, "the match must be reduced to the bare number").toMatch(/cut -d' ' -f1/);

    // ...and the echo puts the unit back exactly once.
    const echo = WORKFLOW.split(/\r?\n/).find((l) => l.includes('echo "Baseline: Tests'));
    expect(echo).toContain('${BASELINE_PASSED:-0} passed');
    expect(echo).not.toContain("passed passed");
  });
});
