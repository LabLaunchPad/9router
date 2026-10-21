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
 * where a failure is produced. It has three rules, and all three are about
 * the VALUE of the fact, not only about whether it is there.
 *
 *   1. A LOCAL failure — one raised on the core's own account, before
 *      anything was sent — has to say `upstreamContacted: false`.
 *   2. EVERY failure result has to carry the fact, whatever its status.
 *   3. A failure that says `upstreamContacted: false` has to BE a local
 *      failure: a 4xx raised on the core's own account, written out.
 *
 * Rules 1 and 3 say the same thing from the two ends, and between them they
 * pin the fact to the status: a failure that says "the provider was never
 * asked" has to name a local 4xx, and a failure that names a local 4xx has
 * to say "the provider was never asked". A failure that breaks either half
 * hands the breaker a value it will read the wrong way.
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
 * The first and third rules are the ones round 17 and round 18 found. The
 * first two rules used to ask whether the fact is THERE; the direction that
 * matters is whether it is RIGHT. A core that marks an upstream failure as
 * one that never reached the provider passes a presence check — the fact is
 * present, and it is on a failure that looks local — and the breaker then
 * reads a provider that is down as a provider that was never asked.
 *
 * And the presence check had a hole of its own: it accepted the
 * constructor that says the provider WAS asked as evidence that a local
 * failure says it was not. That constructor is the opposite of the
 * evidence, so a local failure written through it was invisible. The first
 * rule now asks for the VALUE — `false`, not the presence of the word —
 * and the constructor that says "false" is the only constructor that
 * satisfies it.
 *
 * The scan reads STATEMENTS, not lines. A call written across four lines
 * has its status on the second one, and a scan that reads the line the
 * status is on never sees the call at all.
 *
 * A bracket inside a string is not a bracket. A message that holds an
 * unbalanced "(" must not carry the count past the end of the call: the
 * statement below it would then vouch for a failure that says nothing, and
 * a later statement's fact would read as the failure's own.
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
 * The constructors that build a failure result. A call to one of them is a
 * failure whatever its arguments say, so the scan has to see them all: the
 * one that says the provider was asked and the one that says it was not.
 */
const FAILURE_CONSTRUCTORS = ["createErrorResult", "createLocalErrorResult"];

/**
 * Words that are followed by a bracket and are not calls.
 */
const NOT_A_CALL = ["if", "for", "while", "switch", "catch", "return", "function", "typeof"];

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
 * The text a call spans: its arguments, from the bracket that opens it to
 * the bracket that closes it.
 *
 * The call is read to its closing bracket, not to the next semicolon: a
 * semicolon ends the STATEMENT, and a statement can hold more than one
 * call — reading to it would let a later call vouch for this one, which is
 * the difference between a check and a coincidence.
 */
function callText(lines, index, open) {
  const state = { quote: null };
  const parts = [];
  let depth = 1; // the call's own opening bracket
  for (let j = index; j < lines.length && j <= index + 12; j += 1) {
    const segment = j === index ? lines[j].slice(open + 1) : lines[j];
    const scan = scanBrackets(segment, state, depth);
    if (scan.end >= 0) {
      parts.push(segment.slice(0, scan.end + 1));
      return parts.join("\n");
    }
    parts.push(segment);
    depth = scan.depth;
  }
  return parts.join("\n");
}

/**
 * Walk a piece of text and count the brackets it opens and closes.
 *
 * A bracket inside a string or a comment is text, not a bracket: a message
 * that holds an unbalanced "(" must not carry the count past the end of the
 * call, or the call's text runs on into the statements below it and a later
 * statement's fact vouches for a failure that has none.
 *
 * The string state is carried from one line to the next, because a string
 * can run past the end of a line.
 *
 * The index of the bracket that closes the outermost one is returned with
 * it, so the caller can cut the text at the call's own closing bracket.
 */
function scanBrackets(text, state, depth = 0) {
  let end = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (state.quote) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === state.quote) {
        state.quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      state.quote = ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") break; // a comment
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  return { depth, end };
}

/**
 * Every call a line makes, with the text each call spans.
 *
 * A line can hold more than one call — a condition and the failure it
 * guards — and they are separate statements of fact. The status is read
 * from the call's OWN first argument: the bracket of the condition is not
 * the bracket of the failure.
 */
function callsOn(lines, index) {
  const line = lines[index];
  const found = [];
  const pattern = /[A-Za-z_$][\w$]*\s*\(/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    const name = match[0].slice(0, -1).trim();
    if (NOT_A_CALL.includes(name)) continue;
    const open = match.index + match[0].length - 1;
    found.push({ name, text: callText(lines, index, open) });
  }
  return found;
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
  const argument = text.match(/^\s*((?:HTTP_STATUS\.)?[A-Za-z_][\w.]*|\d{3})/);
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
 * The fact a failure states: "false", "true", or null when it states none.
 *
 * A value written out beats a constructor: `upstreamContacted: false` is
 * what the failure says, whatever else the statement holds. The shared
 * constructors state the fact by construction — one says the provider was
 * asked, the other says it was not — and the one that says "false" is the
 * one a local failure has to go through. A constructor's name is the
 * constructor's own statement, so it is read from the call rather than from
 * the arguments.
 *
 * A fact the scan cannot read — the shorthand `upstreamContacted`, whose
 * value is a variable — is null, not a guess.
 */
function factOf(text, name) {
  if (/upstreamContacted\s*:\s*false/.test(text)) return "false";
  if (/upstreamContacted\s*:\s*true/.test(text)) return "true";
  if (name && FAILURE_CONSTRUCTORS.includes(name)) {
    return name === "createLocalErrorResult" ? "false" : "true";
  }
  if (/createLocalErrorResult\s*\(/.test(text)) return "false";
  if (/createErrorResult\s*\(/.test(text)) return "true";
  return null;
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
      //
      // A call is recorded when it names a local status, and also when it
      // is one of the shared constructors: a failure that says the provider
      // was never asked and states its status as a variable is the defect
      // the third rule exists to catch, and a scan that only recorded the
      // calls with a local status would never see it.
      for (const call of callsOn(lines, i)) {
        const status = callStatus(call.text);
        const isFailure =
          FAILURE_CONSTRUCTORS.includes(call.name) ||
          (status && LOCAL_STATUSES.includes(status));
        if (!isFailure) continue;
        const says = factOf(call.text, call.name);
        found.push({
          kind: "call",
          file: relative,
          line: i + 1,
          text: line.trim(),
          status,
          says,
          // The shared constructors state the fact by construction: one
          // says the provider was asked, the other says it was not.
          marked: /upstreamContacted\b/.test(call.text) || says !== null,
        });
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
          // A hand-built result states the fact in the literal, so only the
          // literal counts here: a constructor call inside the object is a
          // different failure.
          says: /upstreamContacted\s*:\s*false/.test(object.text)
            ? "false"
            : /upstreamContacted\s*:\s*true/.test(object.text)
              ? "true"
              : null,
          marked: /upstreamContacted\b/.test(object.text),
        });
      }
    });
  }
  return found;
}

/**
 * The failures that are raised on the core's own account, and what they
 * say about the fact.
 *
 * An object literal is only a failure result when it says so. A
 * configuration object that happens to carry a `status:` property is not a
 * failure, and asking it to carry a failure's fact turns the control into
 * something a contributor has to work around: the only ways to satisfy the
 * scan would be to write a false statement on an object that is not a
 * failure, or to rename the property so the scan stops looking at it.
 */
function localFailuresIn(records) {
  return records.filter(
    (f) => f.status && LOCAL_STATUSES.includes(f.status) && isFailureResult(f),
  );
}

function localFailures() {
  return localFailuresIn(failuresIn(coreFiles()));
}

/**
 * Is this record a failure result?
 *
 * A call is one when it is a failure constructor or when it names a local
 * status — the scan only records those. An object is one when it says
 * `success: false`, which is the marker the tree uses for a result that is
 * a failure.
 */
function isFailureResult(record) {
  if (record.kind === "object") return record.isFailure;
  return true;
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
    expect(failures.some((f) => f.says === "false")).toBe(true);
  });

  it("has no local failure that says the provider was asked", () => {
    const wrong = localFailures()
      .filter((f) => f.says !== "false")
      .map((f) => `${f.file}:${f.line}  ${f.text}`);

    // A local failure that says the provider WAS asked is read by the
    // breaker as "the provider ANSWERED": it closes the half-open circuit,
    // so one malformed client request can declare a provider that is still
    // down healthy. The constructor that says the provider was asked is
    // not evidence that a local failure says it was not.
    expect(
      wrong,
      `these local failures do not say that the provider was never contacted: ${wrong.join(" | ")}`,
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
    expect(handBuilt.every((f) => f.says === "false")).toBe(true);
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
      .filter(
        (f) =>
          f.says === "false" &&
          isFailureResult(f) &&
          !(f.status && LOCAL_STATUSES.includes(f.status)),
      )
      .map((f) => `${f.file}:${f.line}  ${f.text}`);

    // A failure that says "the request never reached the provider" takes
    // the local branch in the breaker: the probe is released, nothing is
    // recorded against the provider, and the circuit never opens. A 5xx is
    // never a local failure — the provider was asked and it answered — so a
    // failure that says otherwise keeps a provider that is down in service.
    //
    // The status has to be WRITTEN OUT, too. A failure that says the
    // provider was never asked and states its status as a variable is the
    // same defect wearing a different hat: the scan cannot read the value,
    // and the breaker reads it as the provider's answer.
    expect(
      wrong,
      `these failures say the provider was never contacted, but they do not name a local status: ${wrong.join(" | ")}`,
    ).toEqual([]);
  });

  it("does not judge an object that is not a failure result", () => {
    // A configuration object that happens to carry a `status:` property is
    // not a failure. The record knows it is not one — `isFailure` is false
    // — and the rule that judges a failure's value has to ask.
    const fixture = path.join(process.cwd(), "tests", "unit", "fixtures", "not-a-failure.js");
    const records = failuresIn([fixture]);
    const config = records.find((r) => r.kind === "object");

    expect(config, "the scan did not see the object at all").toBeTruthy();
    expect(config.status).toBe("400");
    expect(config.isFailure).toBe(false);
    // A local status on an object that is not a failure is not a local
    // failure, so the rule has nothing to say about it.
    expect(localFailuresIn(records).map((r) => r.line)).not.toContain(config.line);
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
      local[0].says,
      "the scan saw the call, but not the fact: the failure says nothing",
    ).toBe(null);
  });
});

describe("the scan: the defects it has to catch", () => {
  const fixture = path.join(process.cwd(), "tests", "unit", "fixtures", "local-failure-defects.js");

  it("catches a local failure raised through the constructor that says the provider was asked", () => {
    const failures = failuresIn([fixture]);
    const wrong = failures.filter((f) => f.says === "true" && LOCAL_STATUSES.includes(f.status));

    // The constructor that says "the provider WAS asked" is not evidence
    // that a local failure says it was not. A scan that accepts it sees
    // nothing here, and the breaker reads the failure as an answer.
    expect(
      wrong.length,
      "the scan did not see the local failure that claims the provider was asked",
    ).toBe(2);
  });

  it("catches a failure that claims the provider was never asked without naming a local status", () => {
    const failures = failuresIn([fixture]);
    const wrong = failures.filter((f) => f.says === "false" && !f.status);

    // The status has to be written out for the scan to check the value of
    // the fact. A status the scan cannot read is a status the breaker
    // cannot read either.
    expect(
      wrong.length,
      "the scan did not see the failure that says the provider was never asked and names no status",
    ).toBe(1);
  });

  it("does not let a bracket in a message carry the call's text past the call", () => {
    const failures = failuresIn([fixture]);
    const read = failures.filter((f) => f.says === "false" && LOCAL_STATUSES.includes(f.status));

    // A message that holds an unbalanced "(" must not carry the bracket
    // count past the end of the call: the statement below it says the
    // provider was never asked, and that must not vouch for a failure that
    // says nothing.
    expect(
      read.length,
      "the scan read the fact off a statement that is not part of the call",
    ).toBe(0);
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
