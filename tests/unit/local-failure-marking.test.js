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
 * So the marking is checked, not trusted. The cores are scanned for the
 * places where a local failure is produced, and every one of them has to
 * say what it is. Two shapes count as a local failure:
 *
 *   - a failure built with the error constructor and a LITERAL 4xx status.
 *     A provider's own 4xx never reaches a core as a literal — it arrives
 *     as `providerResponse.status` — so a literal 4xx in a core is always
 *     the core's own decision, and it is always raised before the call.
 *   - a hand-built failure object with a literal 4xx status. The search and
 *     fetch cores assemble their results as literals rather than through
 *     the constructor, which is exactly how they slipped past the
 *     constructor-based convention.
 *
 * This is the shape of the guard in `breaker-probe-resolution.test.js`: a
 * scan of the source, because a control that is only enforced by the
 * reviewer's attention is a convention.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const CORES_DIR = path.join(process.cwd(), "open-sse", "handlers");

/** The 4xx statuses a core can raise on its own account. */
const LOCAL_STATUSES = ["400", "401", "403", "404", "406", "409", "422"];

/** A status a provider can answer with, named as a literal in the source. */
const LITERAL_4XX_CALL = new RegExp(
  `createErrorResult\\(\\s*HTTP_STATUS\\.(BAD_REQUEST|UNAUTHORIZED|FORBIDDEN|NOT_FOUND|NOT_ACCEPTABLE|UNPROCESSABLE_ENTITY)`,
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
        statement.includes("createLocalErrorResult") || statement.includes("upstreamContacted: false");

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
    // The search and fetch cores never went through the error constructor.
    // They are the reason the check above has to look at object literals as
    // well, and they are pinned here so that a later refactor back to the
    // constructor does not quietly narrow the scan.
    const failures = localFailures();
    const fetch = failures.filter((f) => f.file === "open-sse/handlers/fetch/index.js");
    const search = failures.filter((f) => f.file === "open-sse/handlers/search/index.js");

    expect(fetch.length).toBeGreaterThan(0);
    expect(search.length).toBeGreaterThan(0);
    expect(fetch.every((f) => f.marked)).toBe(true);
    expect(search.every((f) => f.marked)).toBe(true);
  });
});
