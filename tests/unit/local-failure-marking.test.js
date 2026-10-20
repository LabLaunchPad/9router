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
 * where a failure is produced. It has three rules.
 *
 *   1. A LOCAL failure — one raised on the core's own account, before
 *      anything was sent — has to say the fact.
 *   2. EVERY failure result has to carry the fact, whatever its status.
 *   3. A failure that says `upstreamContacted: false` has to BE a local
 *      failure: a 4xx raised on the core's own account. A 5xx is never one
 *      — the provider was asked and it answered — and a failure that says
 *      otherwise takes the local branch in the breaker: the probe is
 *      released, nothing is recorded against the provider, and the circuit
 *      never opens for a provider that is down.
 *
 * The second rule is the one that closes the shape that round 14 found: a
 * function that is handed a marked result and rebuilds it without the mark.
 * The rule is a property of the RESULT, not of the function that made it,
 * so it does not care how the function is written — a nested helper, an
 * arrow function and a one-line object literal are all the same thing to
 * it. A rule that recognises a shape is a rule a refactor can walk out of,
 * and this class of defect is the one that has cost two rounds now. The
 * fixture in `tests/unit/fixtures/wrapper-shapes.js` holds one wrapper per
 * shape, and the test at the end of this file says the scan sees all four.
 *
 * The third rule is the one round 17 found. The first two rules ask
 * whether the fact is THERE; the direction that matters is whether it is
 * RIGHT. A core that marks an upstream failure as one that never reached
 * the provider passes both of the first two rules — the fact is present,
 * and it is on a failure that looks local — and the breaker then reads a
 * provider that is down as a provider that was never asked.
 *
 * The scan reads STATEMENTS, not lines. A call written across four lines
 * has its status on the second one, and a scan that reads the line the
 * status is on never sees the call at all.
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
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

const CORES_DIR = path.join(process.cwd(), "open-sse", "handlers");

/**
 * The 4xx statuses a core can raise on its own account.
 *
 * A 4xx is not automatically a local failure — a provider's own 400 is an
 * answer — but a core that writes one out before it has sent anything is
 * raising it on its own account, and these are the statuses it does. The
 * upstream status of a provider's answer is never a literal: it is a
 * variable, and that is the convention this scan reads.
 */
const LOCAL_STATUSES = ["400", "401", "403", "404", "406", "409", "422"];

/**
 * The names of the constants that stand for a local status.
 *
 * Derived from `HTTP_STATUS` rather than written out here, so a constant
 * added to the config is covered by the scan without this file being told.
 */
const LOCAL_STATUS_NAMES = Object.entries(HTTP_STATUS)
  .filter(([, value]) => LOCAL_STATUSES.includes(String(value)))
  .map(([name]) => name);

/**
 * A status that is a local one, named (`HTTP_STATUS.BAD_REQUEST`) or
 * written out (`400`). The numeric form matters: a failure written as
 * `createErrorResult(400, …)` is the same local failure as one written as
 * `createErrorResult(HTTP_STATUS.BAD_REQUEST, …)`, and a scan that only
 * knows the named form does not see it.
 */
const LOCAL_STATUS = new RegExp(
  `(?:HTTP_STATUS\\.)?(?:${LOCAL_STATUS_NAMES.join("|")}|${LOCAL_STATUSES.join("|")})\\b`,
);

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
 * The statement a call spans: the call's line and the lines after it, up
 * to the one that closes the call.
 *
 * The call is read to its closing parenthesis, not to the next semicolon:
 * a semicolon ends the STATEMENT, and a statement can hold more than one
 * call — reading to it would let a later call vouch for this one, which is
 * the difference between a check and a coincidence.
 */
function callText(lines, index) {
  const parts = [lines[index]];
  let depth = parenDepth(lines[index]);
  for (let j = index + 1; depth > 0 && j < lines.length && j <= index + 12; j += 1) {
    parts.push(lines[j]);
    depth += parenDepth(lines[j]);
  }
  return parts.join("\n");
}

/** How many parentheses a line opens, less the ones it closes. */
function parenDepth(line) {
  const opens = (line.match(/\(/g) || []).length;
  const closes = (line.match(/\)/g) || []).length;
  return opens - closes;
}

/**
 * The object literal a line sits in: the run of lines at the same
 * indentation, from the line that opens the object to the line that closes
 * it.
 *
 * The fact and the status are siblings, and a sibling can be written
 * before or after — so the whole object is read, not the line the match
 * happened to be on. An object written on one line is that line.
 */
function objectText(lines, index) {
  const line = lines[index];
  if (line.includes("{") && line.includes("}")) {
    return { text: line, start: index };
  }

  const indent = lines[index].search(/\S/);
  let first = index;
  while (first > 0) {
    const above = lines[first - 1].search(/\S/);
    if (above >= 0 && above < indent) break;
    first -= 1;
  }

  const parts = [];
  if (first > 0) parts.push(lines[first - 1]); // the line that opens it
  for (let j = first; j < lines.length; j += 1) {
    parts.push(lines[j]);
    const inner = lines[j].search(/\S/);
    if (inner >= 0 && inner < indent) break; // the object is closed
  }
  return { text: parts.join("\n"), start: first };
}

/**
 * The status a token stands for, or null when it stands for none.
 *
 * A named constant is resolved through `HTTP_STATUS`, so the scan knows
 * that `HTTP_STATUS.BAD_REQUEST` is a 400 without a hand-written list of
 * names to keep in step with the config.
 */
function statusOf(token) {
  if (!token) return null;
  if (token.startsWith("HTTP_STATUS.")) {
    const value = HTTP_STATUS[token.slice("HTTP_STATUS.".length)];
    return value === undefined ? null : String(value);
  }
  return /^\d{3}$/.test(token) ? token : null;
}

/**
 * The status a CALL produces, or null when it produces none.
 *
 * It is the call's FIRST argument that carries the status, and only a
 * literal counts: a call whose first argument is a comparison — an `if`
 * that tests a status — produces no status at all.
 */
function callStatus(text) {
  const argument = text.match(/\(\s*((?:HTTP_STATUS\.)?[A-Za-z_][\w.]*|\d{3})/);
  return argument ? statusOf(argument[1]) : null;
}

/**
 * The status a failure OBJECT states, or null when it states none.
 *
 * The status of a provider's own answer is never a literal: it is a
 * variable, and that is the convention this scan reads.
 */
function objectStatus(text) {
  const property = text.match(/\bstatus:\s*((?:HTTP_STATUS\.)?[A-Za-z_][\w.]*|\d{3})/);
  return property ? statusOf(property[1]) : null;
}

/**
 * Every failure the cores raise, and what it says about the fact.
 *
 * A failure is either a call that produces one — the shared constructors,
 * or a core's own wrapper — or a result object written out by hand.
 */
function failuresIn(files) {
  const found = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const relative = path.relative(process.cwd(), file).replace(/\\/g, "/");
    const seenObjects = new Set();

    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;

      // A call that produces a failure. The call is the anchor: the status
      // may sit on the NEXT line, and a scan that reads the line the status
      // is on never sees the call at all.
      if (/\w\s*\(/.test(line)) {
        const text = callText(lines, i);
        const status = callStatus(text);
        if (status && LOCAL_STATUSES.includes(status)) {
          found.push({
            kind: "call",
            file: relative,
            line: i + 1,
            text: line.trim(),
            status,
            saysNotContacted:
              /upstreamContacted\s*:\s*false/.test(text) ||
              /createLocalErrorResult\s*\(/.test(text),
            // The shared constructors state the fact by construction: one
            // says the provider was asked, the other says it was not.
            marked:
              /upstreamContacted\b/.test(text) ||
              /createLocalErrorResult\s*\(/.test(text) ||
              /createErrorResult\s*\(/.test(text),
          });
        }
      }

      // A result object written out by hand. One record per object: the
      // status and the fact can be on different lines of the same literal.
      if (line.includes("success: false") || /\bstatus:\s*/.test(line)) {
        const object = objectText(lines, i);
        if (seenObjects.has(object.start)) return;
        seenObjects.add(object.start);
        const status = objectStatus(object.text);
        found.push({
          kind: "object",
          file: relative,
          line: i + 1,
          text: line.trim(),
          status,
          isFailure: object.text.includes("success: false"),
          saysNotContacted: /upstreamContacted\s*:\s*false/.test(object.text),
          marked: /upstreamContacted\b/.test(object.text),
        });
      }
    });
  }
  return found;
}

/**
 * The failures that are raised on the core's own account, and whether
 * they say so.
 */
function localFailures() {
  return failuresIn(coreFiles()).filter((f) => f.status && LOCAL_STATUSES.includes(f.status));
}

/**
 * The failure results the cores build by hand, and whether they carry the
 * fact.
 *
 * The shared constructors are not in this list: `createErrorResult` states
 * that the provider was asked and `createLocalErrorResult` states that it
 * was not, so a failure built through either of them carries the fact by
 * construction. This is about the object literals — the ones a core writes
 * out for itself, which is where a fact gets lost.
 */
function handBuiltFailures() {
  return failuresIn(coreFiles()).filter((f) => f.kind === "object" && f.isFailure);
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
    expect(failures.some((f) => f.marked)).toBe(true);
  });

  it("has no failure result that drops the fact", () => {
    const dropped = handBuiltFailures()
      .filter((f) => !f.marked)
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

describe("the cores: the fact has to be RIGHT", () => {
  it("has no failure that claims the provider was never asked and is not one", () => {
    const wrong = failuresIn(coreFiles())
      .filter((f) => f.saysNotContacted && f.status && !LOCAL_STATUSES.includes(f.status))
      .map((f) => `${f.file}:${f.line}  ${f.text}`);

    // A failure that says "the request never reached the provider" takes
    // the local branch in the breaker: the probe is released, nothing is
    // recorded against the provider, and the circuit never opens. A 5xx is
    // never a local failure — the provider was asked and it answered — so a
    // failure that says otherwise keeps a provider that is down in service.
    expect(
      wrong,
      `these failures say the provider was never contacted, but they are not local failures: ${wrong.join(" | ")}`,
    ).toEqual([]);
  });

  it("sees a local failure written as a call spread over several lines", () => {
    // A call whose status sits on the next line is a statement, not a line.
    // A scan that reads the line the status is on never sees the call — the
    // pattern wants the `(` and the status together — and the failure goes
    // unmarked, which is the shape the third rule above exists to catch.
    // The scan has to see it to check it.
    const fixture = path.join(process.cwd(), "tests", "unit", "fixtures", "multi-line-failure.js");
    const failures = failuresIn([fixture]);
    const local = failures.filter((f) => f.status && LOCAL_STATUSES.includes(f.status));

    expect(
      local.length,
      "the scan did not see the call at all — the status is on the next line",
    ).toBe(1);
    expect(
      local[0].marked,
      "the scan saw the call, but not the fact: the failure is unmarked",
    ).toBe(false);
  });
});

describe("the scan: a rule that recognises a shape is a rule a refactor can walk out of", () => {
  it("sees every wrapper shape, not only the one it was written for", () => {
    // The fixture holds four wrappers that rebuild a failure result and
    // drop the fact, one per shape: a top-level declaration, a nested
    // helper, a differently named parameter, and an arrow function. The
    // rule that replaced the shape-guessing one is a property of the
    // RESULT, so it has to see all four.
    const fixture = path.join(process.cwd(), "tests", "unit", "fixtures", "wrapper-shapes.js");
    const failures = failuresIn([fixture]);
    const dropped = failures.filter((f) => f.kind === "object" && !f.marked);

    expect(
      dropped.length,
      `the scan saw ${dropped.length} of the four wrapper shapes`,
    ).toBe(4);
  });
});
