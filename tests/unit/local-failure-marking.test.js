/**
 * A failure has to SAY what it is.
 *
 * The breaker tells two failures apart by a fact, not by a status: a
 * provider that ANSWERED with a 400 is alive, and a request that was never
 * sent says nothing at all. The fact travels on the failure record
 * (`upstreamContacted`), and the default is "contacted" — so a local
 * failure that is not marked is indistinguishable from a provider that
 * answered, and the half-open circuit closes as though the provider had
 * replied.
 *
 * That failure is silent. No test fails, no log line appears, the circuit
 * closes, and a provider that is still down is declared healthy.
 *
 * This file is the CHEAP SECOND NET: a scan of the cores for the places
 * where a failure is produced. It has two rules.
 *
 *   1. A LOCAL failure — one raised on the core's own account, before
 *      anything was sent — has to say `upstreamContacted: false`.
 *   2. EVERY failure result has to carry the fact, whatever its status.
 *
 * The second rule is the one that closes the shape that round 14 found: a
 * function that is handed a marked result and rebuilds it without the mark.
 * The rule is a property of the RESULT, not of the function that made it,
 * so it does not care how the function is written — a nested helper, an
 * arrow function and a one-line object literal are all the same thing to
 * it. A rule that recognises a shape is a rule a refactor can walk out of,
 * and this class of defect is the one that has cost two rounds now.
 *
 * It is still not the control, and it does not claim to be. A scan of the
 * source cannot see what a core RETURNS after it has wrapped a result, and
 * it cannot see the handler that reads it. The control is behavioural:
 * `local-failure-hand-built-cores.test.js` calls the cores' public entry
 * points and asserts on the result that comes back, and
 * `local-failure-wiring.test.js` drives the handler that hands it to the
 * breaker.
 *
 * The scan earns its place by being wider than the control in one respect:
 * it sees the constructor-based cores, which are awkward to drive, and it
 * sees a failure the moment it is written, wherever it is written.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const CORES_DIR = path.join(process.cwd(), "open-sse", "handlers");

/** The 4xx statuses a core can raise on its own account. */
const LOCAL_STATUSES = ["400", "401", "403", "404", "406", "409", "422"];

/**
 * A call whose first argument is a LITERAL 4xx — named (`HTTP_STATUS.
 * BAD_REQUEST`) or written out (`400`). The numeric form matters: a
 * failure written as `createErrorResult(400, …)` is the same local failure
 * as one written as `createErrorResult(HTTP_STATUS.BAD_REQUEST, …)`, and a
 * scan that only knows the named form does not see it.
 */
const LITERAL_4XX_CALL = new RegExp(
  `\\(\\s*(?:HTTP_STATUS\\.)?(BAD_REQUEST|UNAUTHORIZED|FORBIDDEN|NOT_FOUND|NOT_ACCEPTABLE|UNPROCESSABLE_ENTITY|${LOCAL_STATUSES.join("|")})\\b`,
);

/** A hand-built failure object with a literal 4xx status. */
const LITERAL_4XX_OBJECT = new RegExp(`status:\\s*(${LOCAL_STATUSES.join("|")})\\b`);

function coreFiles() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".js")) {
        found.push(full);
      }
    }
  };
  walk(CORES_DIR);
  return found.sort();
}

/**
 * The statement a match sits in: the matched line and the lines after it up
 * to the one that ENDS the statement.
 *
 * A line that ends the statement itself ends it there. Reading past it
 * would let a fact that belongs to a later statement vouch for this one,
 * which is the difference between a check and a coincidence.
 */
function statementAt(lines, index) {
  const parts = [lines[index]];
  if (lines[index].includes(";")) return parts.join("\n");
  for (let j = index + 1; j < lines.length && j <= index + 12; j += 1) {
    parts.push(lines[j]);
    if (lines[j].includes(";")) break;
  }
  return parts.join("\n");
}

/**
 * Every failure the cores raise, and whether it says what it is.
 */
function localFailures() {
  const found = [];
  for (const file of coreFiles()) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const isCall = LITERAL_4XX_CALL.test(line);
      const isObject = LITERAL_4XX_OBJECT.test(line);
      if (!isCall && !isObject) return;
      // A 4xx that is a COMPARISON, not a status being produced.
      if (/status\s*===/.test(line)) return;

      const statement = statementAt(lines, i);
      const marked =
        statement.includes("createLocalErrorResult") || statement.includes("upstreamContacted");

      found.push({
        file: path.relative(process.cwd(), file).replace(/\\/g, "/"),
        line: i + 1,
        text: line.trim(),
        marked,
      });
    });
  }
  return found;
}

/**
 * Every failure RESULT the cores build by hand, and whether it carries the
 * fact.
 *
 * The shared constructors are not in this list: `createErrorResult` states
 * that the provider was asked and `createLocalErrorResult` states that it
 * was not, so a failure built through either of them carries the fact by
 * construction. This is about the object literals — the ones a core writes
 * out for itself, which is where a fact gets lost.
 */
function handBuiltFailures() {
  const found = [];
  for (const file of coreFiles()) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.includes("success: false")) return;

      const statement = statementAt(lines, i);
      found.push({
        file: path.relative(process.cwd(), file).replace(/\\/g, "/"),
        line: i + 1,
        text: line.trim(),
        carries: statement.includes("upstreamContacted"),
      });
    });
  }
  return found;
}

describe("the cores: a local failure has to say it is one", () => {
  it("finds the local failures, so the check below is not vacuous", () => {
    const failures = localFailures();
    // A scan that matches nothing would pass the check below for the wrong
    // reason, so the scan is pinned.
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((f) => f.marked)).toBe(true);
  });

  it("has no local failure that reaches the breaker unmarked", () => {
    const unmarked = localFailures()
      .filter((f) => !f.marked)
      .map((f) => `${f.file}:${f.line}  ${f.text}`);

    // An unmarked local failure is read by the breaker as "the provider
    // ANSWERED": it closes the half-open circuit, so one malformed client
    // request can declare a provider that is still down healthy.
    expect(
      unmarked,
      `these local failures do not say that the provider was never contacted: ${unmarked.join(" | ")}`,
    ).toEqual([]);
  });

  it("covers the cores that build their results by hand", () => {
    // The search, fetch and chat-search cores never went through the error
    // constructor. They are the reason the check above has to look at object
    // literals and at numeric status literals as well, and they are pinned
    // here so that a later refactor back to the constructor does not quietly
    // narrow the scan.
    const failures = localFailures();
    const handBuilt = failures.filter(
      (f) =>
        f.file === "open-sse/handlers/fetch/index.js" ||
        f.file === "open-sse/handlers/search/index.js" ||
        f.file === "open-sse/handlers/search/chatSearch.js",
    );

    expect(handBuilt.length).toBeGreaterThan(0);
    expect(handBuilt.every((f) => f.marked)).toBe(true);
  });
});

describe("the cores: every failure result carries the fact", () => {
  it("finds the hand-built failure results, so the check below is not vacuous", () => {
    const failures = handBuiltFailures();
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((f) => f.carries)).toBe(true);
  });

  it("has no failure result that drops the fact", () => {
    const dropped = handBuiltFailures()
      .filter((f) => !f.carries)
      .map((f) => `${f.file}:${f.line}  ${f.text}`);

    // A failure result without the fact is read by the breaker as "the
    // provider ANSWERED" — whether it was a local failure or an upstream
    // one, the reader cannot tell. The mark is right at the producer and
    // gone at the consumer, which is the hardest kind of defect to see:
    // nothing fails, nothing is logged, and the circuit closes.
    expect(
      dropped,
      `these failure results do not carry the fact: ${dropped.join(" | ")}`,
    ).toEqual([]);
  });
});
