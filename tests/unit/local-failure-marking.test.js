/**
 * A local failure has to SAY that it is one.
 *
 * The breaker tells two failures apart by a fact, not by a status: a
 * provider that ANSWERED with a 400 is alive, and a request that was never
 * sent says nothing at all. The fact travels on the failure record
 * (`upstreamContacted: false`), and the default is "contacted" — so a local
 * failure that is not marked is indistinguishable from a provider that
 * answered, and the half-open circuit closes as though the provider had
 * replied.
 *
 * That failure is silent. No test fails, no log line appears, the circuit
 * closes, and a provider that is still down is declared healthy.
 *
 * This file is the CHEAP SECOND NET: a scan of the cores for the places
 * where a local failure is produced. It catches a failure that is written
 * out inline and forgets to say what it is.
 *
 * It is not the control, and it does not claim to be. A scan can only
 * recognise the shapes it was told about, and every helper that builds a
 * failure result is a shape it does not know about — a scan of the source
 * cannot see what a core RETURNS after it has wrapped a result. The control
 * is behavioural: `local-failure-hand-built-cores.test.js` calls the cores'
 * public entry points and asserts on the result that comes back.
 *
 * The scan earns its place by being wider than the control in one respect:
 * it sees the constructor-based cores, which are awkward to drive, and it
 * sees a local failure the moment it is written, wherever it is written.
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
 * The statement a match sits in: the matched line and the lines after it
 * up to the one that ends the statement.
 */
function statementAt(lines, index) {
  const parts = [lines[index]];
  for (let j = index + 1; j < lines.length && j <= index + 12; j += 1) {
    parts.push(lines[j]);
    if (lines[j].includes(";")) break;
  }
  return parts.join("\n");
}

/**
 * Every local failure the cores raise, and whether it says what it is.
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

/**
 * The functions in the cores that BUILD a failure result.
 *
 * A function that takes a failure and hands it on — a status, an error, a
 * whole result — has to carry the fact with it. This is the shape that
 * round 14's defect had: the search core's `errorResult` was given a marked
 * result, rebuilt it without the mark, and the fact was gone by the time
 * the handler read it. The call-site scan above sees the arguments; it
 * cannot see the return value of the function they were passed to.
 *
 * The scope is the functions that FORWARD a failure. A function that builds
 * a fresh failure out of an upstream response has no fact to forward — the
 * provider demonstrably answered — so it is not in scope here.
 */
function failureBuilders() {
  const found = [];
  const FUNCTION = /^(export\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)/;
  // A parameter that carries a failure: a status, an error, a whole result.
  const FORWARDS_A_FAILURE = /\b(status|error|result|err|failure|outcome)\b/i;

  for (const file of coreFiles()) {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = line.match(FUNCTION);
      if (!m) return;
      const [, , , name, params] = m;

      // The body: to the end of the function, by indentation.
      const level = line.search(/\S/);
      const body = [];
      for (let j = i + 1; j < lines.length; j += 1) {
        const indent = lines[j].search(/\S/);
        if (indent < 0) continue;
        if (indent <= level && lines[j].trim().startsWith("}")) break;
        body.push(lines[j]);
      }
      const text = body.join("\n");

      // Does it build a failure result at all?
      const builds = text.includes("success: false") || /create(Local)?ErrorResult\s*\(/.test(text);
      if (!builds) return;

      // Does it forward a failure it was given?
      if (!FORWARDS_A_FAILURE.test(params)) return;

      found.push({
        file: path.relative(process.cwd(), file).replace(/\\/g, "/"),
        line: i + 1,
        name,
        text: line.trim(),
        carries: text.includes("upstreamContacted"),
      });
    });
  }
  return found;
}

describe("the cores: a function that forwards a failure forwards the fact", () => {
  it("finds the failure builders, so the check below is not vacuous", () => {
    const builders = failureBuilders();
    expect(builders.length).toBeGreaterThan(0);
    // The function that dropped the fact in round 14 is pinned here: it is
    // in scope, and it carries the fact now.
    const errorResult = builders.find((b) => b.name === "errorResult");
    expect(errorResult, "the search core's errorResult is in scope").toBeTruthy();
    expect(errorResult.file).toBe("open-sse/handlers/search/index.js");
  });

  it("has no failure builder that forwards a failure without the fact", () => {
    const offenders = failureBuilders()
      .filter((b) => !b.carries)
      .map((b) => `${b.file}:${b.line}  ${b.text}`);

    // A builder that drops the fact turns every local failure it handles
    // back into "the provider ANSWERED" — the half-open circuit closes, and
    // a provider that is still down is declared healthy. The mark is
    // correct at the call site and gone at the consumer, which is the
    // hardest kind of defect to see.
    expect(
      offenders,
      `these functions forward a failure without forwarding the fact: ${offenders.join(" | ")}`,
    ).toEqual([]);
  });
});
