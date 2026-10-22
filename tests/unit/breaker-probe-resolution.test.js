/**
 * The half-open probe is a CLAIM, and a claim has to be resolved.
 *
 * `getProviderCredentials` calls `canRequest()`, and in the half-open state
 * that claims the single probe slot. The slot is released by
 * `recordSuccess()`, `recordFailure()` or `releaseProbe()` — and the ONLY
 * production caller of `recordSuccess()` is `clearAccountError`.
 *
 * So a handler that obtains credentials and never calls `clearAccountError`
 * leaves the probe claimed after a SUCCESSFUL request. The circuit stays
 * half-open with its slot held, and `canRequest()` then refuses every later
 * request for that provider — for the whole reset window, and for EVERY
 * handler, not only the one that leaked it.
 *
 * The failure path is fine: `markAccountUnavailable` calls
 * `recordProviderFailure`, which resolves the probe either way. It is the
 * success path that has no resolver.
 *
 * These tests cover both halves: the mechanism, and the reach.
 *
 * The REACH used to be "the files in `src/sse/handlers/`". It is now every
 * file in the tree that claims a probe, because the one file that was
 * outside that scope — the gemini native route, the only path that returns
 * to the client directly — is the one that leaked. A control that depends on
 * where the file that claims the probe happens to live is not a control.
 */

import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  getCircuitBreaker,
  resetAllCircuitBreakers,
} from "../../open-sse/services/circuitBreaker.js";
import {
  getProviderCredentials,
  clearAccountError,
  resetProviderFailureTracking,
} from "../../src/sse/services/auth.js";
import { codeOnly, codeLineFlags } from "./source-scan.js";

// A real no-auth free provider: it takes the early return in
// `getProviderCredentials` that hands back a synthetic credential, and it
// needs no database, so the mechanism can be exercised exactly.
const NO_AUTH_PROVIDER = "opencode";

const SRC_DIR = path.join(process.cwd(), "src");

/** The service that defines the credential lookup — it is not a claimant. */
const CREDENTIAL_SERVICE = path.join("sse", "services", "auth.js");

/**
 * Every way a claimed probe can be resolved.
 *
 * `clearAccountError` and `recordProviderSuccess` record the success.
 * `markAccountUnavailable` resolves the probe on the failure path, and
 * `releaseProviderProbe` on the paths that produce no answer at all.
 *
 * `recordProviderFailure` is in the list for the same reason as the others:
 * it resolves the probe too — it is the direct entry point, for the paths
 * that have no account to lock. The no-auth speech paths use it, and they
 * are paths that claimed a probe.
 *
 * It was missing from this list, and the cost was a false positive: a
 * correct change — resolving the probe through the direct entry point
 * instead of the narrow one — was reported as a leak. A control that
 * blocks a correct change is a control contributors learn to work around,
 * and the workarounds are a redundant resolver, or a comment explaining
 * that the scan is wrong.
 */
const RESOLVERS =
  /\b(clearAccountError|recordProviderSuccess|markAccountUnavailable|recordProviderFailure|releaseProviderProbe)\s*\(/;

/**
 * Does this line CALL a resolver?
 *
 * A mention is not a call. A comment that names a resolver is not a
 * resolver, and neither is a string that mentions one — a scan that counts
 * either can be satisfied by writing a sentence — and, worse, a leftover
 * comment can mask a path that really does leak the probe: the sentence is
 * in the scope, the scope matches, and the scan reports the path as
 * covered when nothing covers it.
 *
 * Three shapes were missed by a filter that only looked at the START of
 * the line:
 *
 *   - a leading comment       `// markAccountUnavailable(`
 *   - a trailing comment      `} // markAccountUnavailable(`
 *   - a mention in a string   `log.info("... markAccountUnavailable(")`
 *
 * So the whole line is read, and the comment and the string are cut off
 * before the resolver is looked for. A line inside a block comment is
 * ruled out by `codeLineFlags`, which is the one thing a single line
 * cannot tell on its own.
 *
 * `codeOnly` and `codeLineFlags` live in `tests/unit/source-scan.js`, and
 * the other two scans that read source use the same two — see the note at
 * the top of that file for why there is one reader and not three.
 */
function callsResolver(text, pattern) {
  const code = codeOnly(text);
  if (!code.trim()) return false;
  return pattern.test(code);
}

beforeEach(() => {
  resetAllCircuitBreakers();
  resetProviderFailureTracking();
});

/**
 * A breaker that has tripped and whose cool-down has elapsed, so the next
 * request is the half-open probe.
 */
function halfOpenBreaker(provider = NO_AUTH_PROVIDER) {
  const cb = getCircuitBreaker(provider, {
    failureThreshold: 1,
    coolDownWindowMs: 60000,
    resetWindowMs: 120000,
  });
  cb.recordFailure();
  expect(cb.state).toBe("open");
  cb.lastStateChangeTime = Date.now() - 60000;
  return cb;
}

/**
 * Every file in the tree that CLAIMS a probe.
 *
 * The scope is the whole of `src/`, not the handlers directory: a file that
 * obtains credentials is a file that owes the breaker a resolution, and the
 * directory it happens to live in is not what makes that true.
 */
function filesThatObtainCredentials() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".js")) {
        if (full.endsWith(CREDENTIAL_SERVICE)) continue;
        const source = fs.readFileSync(full, "utf8");
        if (/getProviderCredentials\s*\(/.test(source)) {
          found.push(path.relative(process.cwd(), full).replace(/\\/g, "/"));
        }
      }
    }
  };
  walk(SRC_DIR);
  return found.sort();
}

describe("circuit breaker: a probe that is never resolved", () => {
  it("a successful request that resolves nothing blackholes the provider", async () => {
    const cb = halfOpenBreaker();

    // The credential lookup claims the probe: the cool-down has elapsed, so
    // the circuit is half-open and this request is the one probe.
    const creds = await getProviderCredentials(NO_AUTH_PROVIDER, null, null);
    expect(creds).toBeTruthy();
    expect(cb.state).toBe("half-open");

    // The upstream request is made with that credential and SUCCEEDS.
    // Nothing resolves the probe — no recordSuccess(), no releaseProbe().

    // The next request for the same provider is refused, and the refusal is
    // indistinguishable from "no credentials".
    const next = await getProviderCredentials(NO_AUTH_PROVIDER, null, null);
    expect(next).toBeNull();
    expect(cb.state).toBe("half-open");
    expect(cb.canRequest()).toBe(false);
  });

  it("the same request, resolved, leaves the provider open for business", async () => {
    const cb = halfOpenBreaker();

    const creds = await getProviderCredentials(NO_AUTH_PROVIDER, null, null);
    expect(creds).toBeTruthy();
    expect(cb.state).toBe("half-open");

    // The resolver: the handler reports the success.
    await clearAccountError(creds.connectionId, creds, null);

    expect(cb.state).toBe("closed");

    const next = await getProviderCredentials(NO_AUTH_PROVIDER, null, null);
    expect(next).toBeTruthy();
  });
});

describe("circuit breaker: every file that claims the probe resolves it", () => {
  it("finds the files that obtain credentials", () => {
    const files = filesThatObtainCredentials();
    // If this list ever comes back empty the checks below would pass
    // vacuously, so it is pinned.
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain("src/sse/handlers/chat.js");
    expect(files).toContain("src/sse/handlers/stt.js");
    expect(files).toContain("src/sse/handlers/tts.js");
    // The file that leaked: the only path that returns to the client
    // directly, and the only one outside the handlers directory. It is in
    // scope now, and it is pinned here so that it cannot quietly leave
    // scope again.
    expect(files).toContain("src/app/api/v1beta/models/[...path]/route.js");
  });

  it("has no file that claims the probe without a way to resolve it", () => {
    const offenders = [];
    for (const file of filesThatObtainCredentials()) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      // A resolver has to be CALLED. A comment or a string that names one
      // is a mention, and a file that only mentions a resolver has no way
      // to resolve the probe.
      const lines = source.split(/\r?\n/);
      const isCode = codeLineFlags(lines);
      const calls = lines.some((line, i) => isCode[i] && callsResolver(line, RESOLVERS));
      if (!calls) offenders.push(file);
    }

    // A file that obtains credentials and never resolves the breaker's probe
    // leaves the provider half-open with its slot held after a successful
    // request, and every later request for that provider is refused for the
    // whole reset window.
    expect(
      offenders,
      `these files obtain credentials but never resolve the breaker's probe: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * The blocks a line sits inside, outermost last.
   *
   * The chain is found by walking up the source and taking every line whose
   * indentation is strictly smaller than the current level — those are the
   * blocks the line is nested in. A closing brace at a smaller indentation
   * ends the innermost block, so the level moves out to it and the walk
   * continues above it.
   */
  function enclosingBlocks(lines, index) {
    const blocks = [];
    let level = lines[index].search(/\S/);
    for (let j = index - 1; j >= 0; j -= 1) {
      const indent = lines[j].search(/\S/);
      if (indent < 0) continue; // blank line
      if (indent >= level) continue; // still inside the current block
      const text = lines[j].trim();
      if (text.endsWith("{")) blocks.push(text);
      level = indent;
    }
    return blocks;
  }

  /**
   * Is this block one the SUCCESS path goes through?
   *
   * Two shapes count: the success callback the cores invoke once the
   * upstream request has answered, and a branch on a success flag that is
   * not negated. A branch on `!result.success` is the failure path, and a
   * resolver there does not resolve a successful request's probe.
   *
   * `response.ok` counts as a success branch: it is how the paths that
   * return to the client directly recognise that the provider answered.
   *
   * The negation has to be read the whole way. `!result.success` and
   * `!response.ok` are the same shape of branch, and a filter that only
   * recognised `!success` would call both of them success branches — so a
   * file that resolves the probe ONLY inside such a branch would pass this
   * check. That is the defect the check exists to catch, and the direct
   * routes branch on `!response.ok` more often than on anything else.
   */
  function isSuccessBlock(text) {
    if (/onRequestSuccess\s*:/.test(text)) return true;
    const m = text.match(/^(?:\}\s*else\s+)?if\s*\((.*)\)/);
    if (!m) return false;
    const cond = m[1];
    if (!/success/i.test(cond) && !/\.ok\b/.test(cond)) return false;
    if (/!\s*[\w.?]*(?:success|\.ok)\b/i.test(cond)) return false;
    return true;
  }

  it("does not count a negated success condition as a success branch", () => {
    // A failure branch is not a success branch, whichever way it is
    // written. The member-access forms are the ones that matter: the
    // direct-return routes branch on `!response.ok`, so a filter that
    // missed them would let a file resolve the probe on the failure path
    // only — and pass.
    expect(isSuccessBlock("if (!response.ok) {")).toBe(false);
    expect(isSuccessBlock("if (!result.success) {")).toBe(false);
    expect(isSuccessBlock("if (!result?.success) {")).toBe(false);
    expect(isSuccessBlock("if (!success) {")).toBe(false);
    expect(isSuccessBlock("if (!res.ok) {")).toBe(false);

    // And the positive cases have to keep working: a branch that is not
    // negated IS the success path.
    expect(isSuccessBlock("if (response.ok) {")).toBe(true);
    expect(isSuccessBlock("if (result.success) {")).toBe(true);
    expect(isSuccessBlock("if (result?.success) {")).toBe(true);
    expect(isSuccessBlock("onRequestSuccess: () => {")).toBe(true);
  });

  /**
   * The success resolver that settles each CLAIM's probe.
   *
   * A presence proxy is not enough: a file that NAMES a resolver but calls
   * it only on its failure path leaves exactly the defect this file is
   * about — a successful request whose probe stays claimed. So the
   * resolver is tied to the success path here.
   *
   * It used to be a question about the FILE: does this file settle the
   * probe on its success path? A file with two claims and one resolver
   * passed — and the other claim leaked its probe, for the whole reset
   * window, for every handler that used the provider. So the question is
   * now asked of each CLAIM.
   *
   * A resolver settles a claim when the claim's flow reaches it:
   *
   *   - directly: the resolver is inside the claim's own scope and comes
   *     after it. A resolver ABOVE the claim cannot settle it — the claim
   *     has not been made yet — and a resolver in a sibling arm never runs
   *     on the claim's path.
   *   - through the success callback the core is handed: the callback is
   *     created after the claim, in a block that encloses it, and the core
   *     calls it when the request succeeds. This is the shape the search
   *     and image paths use, and the shape the FAILURE rule deliberately
   *     refuses — a callback that settles the probe on success says
   *     nothing about the failure path, which is the path that rule
   *     examines.
   *   - in a helper the claim's function calls: the helper settles the
   *     probe when the request succeeds.
   *
   * A file where NO claim is settled is reported whole: the file does not
   * settle the probe on its success path at all. That is the verdict the
   * file-level rule gave, and it is unchanged.
   *
   * It is a function of the file's source, not of the tree it lives in, so
   * a FIXTURE can be pointed at it — the same reason the path scan can.
   */
  function successProbeLeaksIn(file, source) {
    const SUCCESS_RESOLVERS = /\b(clearAccountError|recordProviderSuccess)\s*\(/;
    const lines = source.split(/\r?\n/);
    const isCode = codeLineFlags(lines);

    const claims = [];
    lines.forEach((line, i) => {
      if (!isCode[i]) return;
      if (/getProviderCredentials\s*\(/.test(line)) {
        claims.push({ index: i, scope: scopeOf(lines, i) });
      }
    });

    const resolvers = [];
    lines.forEach((line, i) => {
      if (!isCode[i]) return;
      if (!callsResolver(line, SUCCESS_RESOLVERS)) return;
      if (!enclosingBlocks(lines, i).some(isSuccessBlock)) return;
      const scope = scopeOf(lines, i);
      resolvers.push({ index: i, scope, block: scope[0] ?? null });
    });

    const settled = (claim) => resolvers.some((r) => settlesClaim(lines, claim, r, isCode));

    if (!claims.some(settled)) return [file];

    return claims.filter((c) => !settled(c)).map((c) => `${file}:${c.index + 1}`);
  }

  /**
   * Does this resolver settle the probe this claim made?
   *
   * Three shapes settle it:
   *
   *   - directly: the resolver is inside the claim's own scope and comes
   *     after it. A resolver ABOVE the claim cannot settle it — the claim
   *     has not been made yet — and a resolver in a sibling arm never runs
   *     on the claim's path.
   *   - through the success callback the core is handed: the callback is
   *     created after the claim, in a block that encloses it, and the core
   *     calls it when the request succeeds. This is the shape the search
   *     and image paths use, and the shape the FAILURE rule deliberately
   *     refuses — a callback that settles the probe on success says
   *     nothing about the failure path, which is the path that rule
   *     examines.
   *   - in a helper the claim's function calls: the helper settles the
   *     probe when the request succeeds.
   */
  function settlesClaim(lines, claim, resolver, isCode) {
    if (isInScope(claim.scope, resolver.scope)) {
      return resolver.index > claim.index;
    }

    if (isCallbackBlock(resolver.block)) {
      const carrier = carrierOf(lines, resolver.block);
      if (!carrier) return false;
      return carrier.index > claim.index && isInScope(carrier.scope, claim.scope);
    }

    return helperSettles(lines, claim, resolver, isCode);
  }

  /**
   * Does a helper the claim's own function calls settle the claim?
   *
   * The resolver is in another function, so it is not in the claim's
   * scope. It settles the claim when the claim's function calls that
   * function, after the claim: the call reaches the helper, and the helper
   * settles the probe when the request succeeds.
   *
   * A resolver in a function the claim's function never calls is not
   * reachable, and does not settle anything.
   */
  function helperSettles(lines, claim, resolver, isCode) {
    const name = functionNameAt(lines, resolver.index);
    if (!name) return false; // the holder cannot be named → cannot tell
    const call = new RegExp(`\\b${name}\\s*\\(`);
    // `codeOnly` is called per line, and it cannot see a block comment that
    // spans lines: a line inside a /* … */ is code to it. So a comment that
    // mentions the helper by name could be read as a call, and a claim
    // would be settled by a sentence. The file-level flags track the block
    // state across the whole file, and they are what this reads.
    for (let i = claim.index + 1; i < lines.length; i += 1) {
      if (!isCode[i]) continue;
      if (!call.test(codeOnly(lines[i]))) continue;
      if (!isInScope(claim.scope, scopeOf(lines, i))) continue;
      return true;
    }
    return false;
  }

  /**
   * Is this block the body of a callback the core is handed?
   *
   * The shape is a property whose value is a function:
   * `onRequestSuccess: async () => { … }`. A function that is a statement
   * of its own — `const onOk = async () => { … }` — is a callback too, but
   * the call that uses it is somewhere else entirely, so it is handled
   * apart.
   */
  const CALLBACK_BLOCK = /^[A-Za-z_$][\w$]*\s*:\s*(async\s*)?(\(|function\b)/;

  function isCallbackBlock(block) {
    return !!block && CALLBACK_BLOCK.test(block.header);
  }

  /**
   * The statement that creates a callback: the call the callback is an
   * argument of.
   *
   * The callback is a property of an object literal, so the statement that
   * creates it is the line the object literal starts on — the first line
   * above the property whose indentation is smaller.
   *
   * A callback handed over by name is created by a statement of its own,
   * and the call that uses it cannot be found by walking up the source. The
   * scan says so rather than guessing: a resolver it cannot place is a
   * resolver it cannot count, and the claim is reported rather than passed
   * quietly.
   */
  function carrierOf(lines, block) {
    const header = block.headerLine;
    if (/^\s*(?:const|let|var)\s/.test(lines[header])) return null;
    const indent = lines[header].search(/\S/);
    for (let j = header - 1; j >= 0; j -= 1) {
      const ind = lines[j].search(/\S/);
      if (ind < 0) continue; // blank
      if (ind >= indent) continue; // still inside the property's line
      return { index: j, scope: scopeOf(lines, j) };
    }
    return null;
  }

  it("resolves the probe on the success path, not merely somewhere in the file", () => {
    const offenders = [];
    for (const file of filesThatObtainCredentials()) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      offenders.push(...successProbeLeaksIn(file, source));
    }

    // A resolver that is only reached on the failure path is as good as no
    // resolver at all: the success path is the one that leaves the probe
    // claimed, and it is the one that blackholes the provider.
    expect(
      offenders,
      `these claims do not resolve the breaker's probe on the success path: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * The success rule asks about each CLAIM, not about the file.
   *
   * It used to ask about the file: "does this file settle the probe on its
   * success path?" A file with two claims and one resolver passed — and the
   * claim the resolver did not reach leaked its probe, for the whole reset
   * window, for every handler that used the provider.
   *
   * The rule is now asked of each claim, and each shape it has to tell
   * apart lives in a fixture. The real tree contains none of them — the two
   * claims in every handler are in different branches, and each branch has
   * its own resolver — so nothing else would exercise the difference.
   */
  it("asks about each claim, and each shape of settlement", () => {
    const FIXTURES = path.join(process.cwd(), "tests", "unit", "fixtures");

    const scanFixture = (name) => {
      const file = path.join(FIXTURES, name);
      const source = fs.readFileSync(file, "utf8");
      return successProbeLeaksIn(name, source);
    };

    // Two claims, one resolver: the claim the resolver does not reach leaks
    // its probe. The file-level rule passed this file — the resolver is
    // somewhere in it.
    expect(
      scanFixture("probe-success-two-claims.js"),
      "a claim the resolver does not reach leaks the probe, even when another claim in the file is settled",
    ).not.toEqual([]);

    // A resolver ABOVE the claim settles nothing: the claim has not been
    // made when the resolver runs. Exactly one claim is reported — the
    // second one — and the first is not, because its resolver is above it.
    expect(
      scanFixture("probe-success-resolver-above-claim.js"),
      "a resolver above the claim cannot settle it",
    ).toEqual(["probe-success-resolver-above-claim.js:41"]);

    // The claim inside a conditional, and the success callback that settles
    // it created further down the same block: the claim IS settled. This is
    // the shape that stopped the earlier attempt, and the search path is
    // written exactly like this.
    expect(
      scanFixture("probe-success-claim-then-callback.js"),
      "a claim reaches the success callback created after it",
    ).toEqual([]);

    // The resolver is in a helper the claim's function calls: the helper
    // settles the claim.
    expect(
      scanFixture("probe-success-helper-settles.js"),
      "a helper the claim's function calls settles the claim",
    ).toEqual([]);
  });


  /**
   * The blocks a line sits in: their header and their body, innermost first.
   *
   * A block is the innermost one whose header is above the line, and its
   * body is the run of lines below the header that are indented deeper than
   * it. Brace counting is not used: the source is full of template literals
   * whose braces are not blocks.
   */
  function blocksAbove(lines, index) {
    const blocks = [];
    let level = lines[index].search(/\S/);
    for (let j = index - 1; j >= 0; j -= 1) {
      const indent = lines[j].search(/\S/);
      if (indent < 0) continue; // blank line
      if (indent >= level) continue; // still inside the current block
      if (lines[j].trim().endsWith("{")) {
        const body = [];
        for (let k = j + 1; k <= index; k += 1) {
          const inner = lines[k].search(/\S/);
          if (inner < 0) continue; // blank
          if (inner <= indent) break; // the block ended
          body.push(lines[k]);
        }
        blocks.push({ header: lines[j].trim(), body: body.join("\n") });
      }
      level = indent;
    }
    return blocks;
  }

  /**
   * The scope of a path: the blocks it sits inside, innermost first.
   *
   * A block is found by its header: the nearest line above whose indentation
   * is smaller and which ends with `{`. Its body is the run of lines below
   * the header that are indented deeper than it.
   *
   * The scope is what a path is inside, and a function body IS a block — so
   * the scope of a path does not depend on how the function is written. An
   * arrow-function handler, a nested helper and a `function` declaration all
   * have a body, and this walk finds all three. Brace counting is not used:
   * the source is full of template literals whose braces are not blocks.
   */
  function scopeOf(lines, index) {
    const blocks = [];
    let level = lines[index].search(/\S/);
    for (let j = index - 1; j >= 0; j -= 1) {
      const indent = lines[j].search(/\S/);
      if (indent < 0) continue; // blank line
      if (indent >= level) continue; // still inside the current block
      if (lines[j].trim().endsWith("{")) {
        const body = [];
        for (let k = j + 1; k <= index; k += 1) {
          const inner = lines[k].search(/\S/);
          if (inner < 0) continue; // blank
          if (inner <= indent) break; // the block ended
          body.push({ text: lines[k], index: k });
        }
        blocks.push({ header: lines[j].trim(), headerLine: j, body });
      }
      level = indent;
    }
    return blocks;
  }

  /**
   * Does this resolver count for a path?
   *
   * A resolver counts when the path reaches it on every branch. Two shapes
   * do not qualify:
   *
   * - the arm of a conditional expression. It runs on one branch only, and
   *   the branch that takes the other arm never reaches it — so it cannot
   *   stand in for the block it sits in.
   * - a resolver in a block the path does not sit inside: the other arm of
   *   an if/else, or a callback. It may not run on this path at all, so it
   *   cannot stand in for it either. The blocks the resolver is in have to
   *   be the path's blocks, compared from the outermost inward — the same
   *   rule a credential lookup is held to.
   */
  function countsAsResolver(lines, line, pathScope, isCode) {
    if (isCode && !isCode[line.index]) return false;
    if (!callsResolver(line.text, RESOLVERS)) return false;
    const trimmed = line.text.trim();
    if (trimmed.startsWith("?") || trimmed.startsWith(":")) return false;
    return isInScope(scopeOf(lines, line.index), pathScope);
  }

  /**
   * Is a lookup in the scope of a path?
   *
   * The lookup is in scope when the path sits inside the scope the lookup
   * is in: the blocks the lookup is in are the path's blocks, compared from
   * the outermost inward. A lookup in a different function is not in scope
   * — whether the path reached it through a call is not something a scan of
   * the source can tell, and a check that cannot tell has to say so.
   */
  function isInScope(lookupScope, pathScope) {
    if (lookupScope.length > pathScope.length) return false;
    for (let k = 0; k < lookupScope.length; k += 1) {
      const outer = lookupScope[lookupScope.length - 1 - k];
      const outerPath = pathScope[pathScope.length - 1 - k];
      if (!outerPath || outer.headerLine !== outerPath.headerLine) return false;
    }
    return true;
  }

  /**
   * The name of the function a line sits in, or null when it cannot be
   * found.
   *
   * The innermost function wins: a helper nested inside another function is
   * the one that runs first.
   */
  function functionNameAt(lines, index) {
    for (const block of scopeOf(lines, index)) {
      const declared = block.header.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/);
      if (declared) return declared[1];
      const assigned = block.header.match(
        /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function\b)/,
      );
      if (assigned) return assigned[1];
    }
    return null;
  }

  /**
   * The paths in ONE file that leave the request with the probe claimed.
   *
   * The scan is a function of the file's source, not of the tree it lives
   * in, so it can be pointed at a FIXTURE. That is the point: a rule that
   * is only ever exercised against the real tree cannot be pinned, because
   * the real tree does not contain the shapes the rule exists to reject.
   * The fixtures carry those shapes, and they are scanned by this same
   * function — a fixture that proved something else would prove nothing.
   *
   * @returns {{offenders: string[], undetermined: string[], candidates: object[]}}
   */
  function probeLeaksIn(file, source) {
    // An error response: a response built at the return site, or a call to
    // a helper that builds one. The status is often on a line of its own —
    // a multi-line `Response.json(...)` call — so the whole statement is
    // read, not just the `return` line.
    const ERROR_RESPONSE_AT_RETURN = /return\s+(new\s+)?Response(\.json)?\s*\(/;
    const ERROR_RESPONSE_BY_HELPER =
      /return\s+\w*(error|Error|unavailable|Unavailable|jsonResponse|JsonResponse)\w*\s*\(/;
    const LOCAL_4XX =
      /\b(?:status:\s*|HTTP_STATUS\.)(400|401|403|404|406|409|422|499|BAD_REQUEST|UNAUTHORIZED|FORBIDDEN|NOT_FOUND|NOT_ACCEPTABLE|UNPROCESSABLE_ENTITY)\b/;
    // A status the scan cannot read: it is a variable, so it may hold a
    // local 4xx as well as an upstream status. A path whose status is
    // unreadable is a path the scan has to ASK about — the same way it
    // asks about a path whose status it CAN read and knows to be local.
    //
    // A status is READABLE when it is written out — a number, or a named
    // constant — and unreadable when it is a variable. The variable can be
    // a property of an object (`result.status`), an argument
    // (`unavailableResponse(status, …)`) or a local name, and all three
    // are the same shape: the scan cannot tell a local 4xx from an
    // upstream status, so it has to ask.
    //
    // A scan that only reads written-out statuses never sees those paths,
    // and a path it never sees is a path it cannot vouch for.
    const STATUS_MENTIONED = /\bstatus\b/i;
    const STATUS_WRITTEN_OUT =
      /\bstatus\s*[:=]\s*(?:\d{3}|(?:HTTP_STATUS\.)?[A-Z][A-Z0-9_]*)\b/;
    const statusIsUnreadable = (text) =>
      STATUS_MENTIONED.test(text) && !STATUS_WRITTEN_OUT.test(text);

    const offenders = [];
    const undetermined = [];

    const lines = source.split(/\r?\n/);
    const isCode = codeLineFlags(lines);

    // Every credential lookup in the file, with the scope it sits in.
    // A commented-out lookup is not a lookup: the request does not take
    // that path, so nothing is claimed there.
    const lookups = [];
    lines.forEach((line, i) => {
      if (!isCode[i]) return;
      if (/getProviderCredentials\s*\(/.test(line)) {
        lookups.push({ index: i, scope: scopeOf(lines, i) });
      }
    });

    // Every path that can leave the request with the probe still claimed.
    //
    // Two kinds of path owe a resolution:
    //
    // - a return that answers the client with a local 4xx, and
    // - an account rotation: the `continue` that hands the request to the
    //   next account. The lookup that claimed the probe is in the same
    //   loop, and the next iteration's lookup finds the breaker refusing
    //   this provider while the probe is still held — so a rotation that
    //   does not resolve the probe blackholes the provider for the whole
    //   reset window.
    const paths = [];
    const candidates = [];
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      // A line that is not code is not a path. A return that was commented
      // out is not a path the request can take, and asking about it is
      // noise — or, worse, noise that masks a real path.
      if (!isCode[i]) return;

      if (/^continue\s*;/.test(trimmed)) {
        paths.push({ index: i, kind: "rotates to the next account" });
        return;
      }

      const code = codeOnly(line);
      if (!/return\s+/.test(code)) return;
      if (!ERROR_RESPONSE_AT_RETURN.test(code) && !ERROR_RESPONSE_BY_HELPER.test(code)) return;
      const statement = [code];
      for (let j = i + 1; j < lines.length && j <= i + 6; j += 1) {
        statement.push(isCode[j] ? codeOnly(lines[j]) : "");
        if (lines[j].includes(";")) break;
      }
      const text = statement.join("\n");
      if (!LOCAL_4XX.test(text) && !statusIsUnreadable(text)) return;
      paths.push({ index: i, kind: "returns an error", statement: text });
    });

    for (const path of paths) {
      const i = path.index;
      const line = lines[i];
      const scope = scopeOf(lines, i);

      // Every path the scan ASKED about, and what became of it. The list
      // is what the reach of the check is: a path the scan never asked
      // about is a path it cannot vouch for, so the list is worth having.
      const asked = { line: i + 1, kind: path.kind, statement: path.statement ?? null, fate: "" };

      // The probe is claimed by the credential lookup, so only a path that
      // comes after one can leak it.
      const earlier = lookups.filter((l) => l.index < i);
      if (!earlier.length) {
        asked.fate = "no credential lookup precedes it";
        candidates.push(asked);
        continue;
      } // nothing had been claimed yet

      // A lookup is in this path's scope when the path sits inside the
      // scope the lookup is in.
      const inScope = earlier.filter((l) => isInScope(l.scope, scope));

      // A lookup in another scope is this path's business only if the
      // path calls the function that holds it — a sibling function's own
      // lookup is nobody else's business.
      const reachable = earlier.filter((l) => {
        if (isInScope(l.scope, scope)) return false;
        const name = functionNameAt(lines, l.index);
        if (!name) return true; // the holder cannot be named → cannot tell
        const call = new RegExp(`\\b${name}\\s*\\(`);
        return scope.some((b) => b.body.some((line) => call.test(line.text)));
      });

      if (!inScope.length && reachable.length) {
        // The lookup is in a helper this path calls. Whether the probe was
        // claimed on this path is not something a scan of the source can
        // tell, and a check that cannot tell has to say so rather than
        // pass quietly.
        asked.fate = "the lookup is in a helper this path calls";
        candidates.push(asked);
        undetermined.push(`${file}:${i + 1}  ${line.trim()}`);
        continue;
      }
      if (!inScope.length) {
        asked.fate = "no credential lookup in this path's scope";
        candidates.push(asked);
        continue;
      } // nothing on this path could have claimed it

      // The branch where the lookup found nothing: the probe was never
      // claimed there, so nothing is owed.
      const foundNothing = inScope.some((lookup) => {
        const target = lines[lookup.index].match(/(?:const|let|var)\s+(\w+)\s*=/);
        const pattern = target
          ? new RegExp(`(!\\s*${target[1]}\\b|${target[1]}\\.allRateLimited\\b)`)
          : /(!\s*credentials\b|credentials\.allRateLimited\b)/;
        return scope.some((b) => pattern.test(b.header));
      });
      if (foundNothing) {
        asked.fate = "the lookup found nothing";
        candidates.push(asked);
        continue;
      }

      // A resolver in the chain of enclosing blocks counts: the release
      // may be made once above the branch rather than inside it.
      //
      // Two shapes do not count, because neither runs on every path that
      // reaches here:
      //
      // - a resolver that is the arm of a conditional expression. It runs
      //   on one branch only, and the branch that takes the other arm
      //   never reaches it.
      // - a resolver inside a function the path is not inside. A callback
      //   that resolves the probe when the request succeeds says nothing
      //   about the failure path being examined.
      if (scope.some((b) => b.body.some((l) => countsAsResolver(lines, l, scope, isCode)))) {
        asked.fate = "a resolver in the path's own scope";
        candidates.push(asked);
        continue;
      }

      asked.fate = "nothing resolves the probe on this path";
      candidates.push(asked);
      offenders.push(`${file}:${i + 1}  ${path.kind}: ${line.trim()}`);
    }

    return { offenders, undetermined, candidates };
  }

  it("has no error response after the credential lookup that leaves the probe claimed", () => {
    // The reach checks above are about the SUCCESS path. This one is about
    // the paths that produce NO ANSWER: a path that returns an error to the
    // client after it has claimed the probe has to release it, or the
    // provider stays half-open with its slot held and every later request
    // to it is refused — and every refusal is counted as an error against
    // the error budget.
    //
    // The gemini native route had three such paths — a client that walked
    // away before the request was sent, a client that walked away during
    // it, and a credential with no API key — and none of them touched the
    // breaker.
    //
    // The scope of a path is its chain of enclosing blocks, and a function
    // body is a block: the check does not have to recognise how a function
    // is written to know what encloses a path. An arrow-function handler
    // and a nested helper are in scope exactly like a declaration — and a
    // path the check cannot place is reported, not skipped.
    const offenders = [];
    const undetermined = [];

    for (const file of filesThatObtainCredentials()) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      const leaks = probeLeaksIn(file, source);
      offenders.push(...leaks.offenders);
      undetermined.push(...leaks.undetermined);
    }

    expect(
      offenders,
      `these paths leave the request with the probe still claimed and nothing resolving it: ${offenders.join(" | ")}`,
    ).toEqual([]);

    // A path the check cannot place is a path the check cannot vouch for.
    // Silence would read as coverage.
    expect(
      undetermined,
      `these paths are in a scope the check cannot determine: ${undetermined.join(" | ")}`,
    ).toEqual([]);
  });

  /**
   * The scope rule, pinned by fixtures.
   *
   * The rule says a resolver counts for a path only when the resolver's
   * chain of enclosing blocks is the path's chain, compared from the
   * outermost inward. Two shapes do not count:
   *
   *   - a resolver in the other arm of a conditional, and
   *   - a resolver inside a callback.
   *
   * Neither runs on the path, so neither can stand in for it.
   *
   * The rule used to be weaker: it asked only whether the resolver and the
   * path shared a FUNCTION. Both of the shapes above are written inside
   * the same function as the path, so the weaker rule counted them, the
   * path looked covered, and the scan reported the tree as clean. The
   * real tree contains neither shape, so nothing exercised the difference
   * — and the rule was weakened once already, and the hole it was meant
   * to close survived the fix that followed.
   *
   * So the shapes live in fixtures, and the fixtures are scanned by the
   * same function that scans the tree. A fixture that proved something
   * else would prove nothing.
   */
  it("does not count a resolver the path does not reach", () => {
    const FIXTURES = path.join(process.cwd(), "tests", "unit", "fixtures");

    const scanFixture = (name) => {
      const file = path.join(FIXTURES, name);
      const source = fs.readFileSync(file, "utf8");
      return probeLeaksIn(name, source);
    };

    // The resolver is in the other arm of the conditional: the path does
    // not reach it, so nothing resolves the probe on that path.
    const sibling = scanFixture("probe-sibling-branch.js");
    expect(
      sibling.offenders,
      "a resolver in the sibling arm of a conditional does not resolve the path's probe",
    ).not.toEqual([]);

    // The resolver is inside a callback that fires on the success path:
    // it says nothing about the failure path being examined.
    const callback = scanFixture("probe-callback-resolver.js");
    expect(
      callback.offenders,
      "a resolver inside a callback does not resolve the path's probe",
    ).not.toEqual([]);

    // And the case that has to keep working: a resolver in the path's own
    // scope covers it. A rule that rejected this would be rejecting
    // correct code.
    const inScope = scanFixture("probe-resolved-in-scope.js");
    expect(
      inScope.offenders,
      "a resolver in the path's own scope resolves the path's probe",
    ).toEqual([]);
  });

  it("asks about a path whose status it cannot read", () => {
    // The rule the document describes: a path whose status the check
    // cannot read is a path it asks about. The status is a variable here,
    // so it may hold a local 4xx as well as an upstream status, and the
    // check cannot tell which.
    //
    // A narrower rule — one that reads the status only off an object,
    // `result.status` — misses this shape, and the paths it misses are
    // the ones the no-answer check exists for: a handler that answers the
    // client with the status it was given, without writing it out.
    const FIXTURES = path.join(process.cwd(), "tests", "unit", "fixtures");
    const file = path.join(FIXTURES, "probe-unreadable-status.js");
    const source = fs.readFileSync(file, "utf8");

    const leaks = probeLeaksIn("probe-unreadable-status.js", source);

    // The uncovered path is reported.
    expect(
      leaks.offenders.length,
      `exactly one path is reported: the uncovered one — ${leaks.offenders.join(" | ")}`,
    ).toBe(1);
    expect(
      leaks.offenders[0],
      "the path that is reported is the uncovered one",
    ).toContain("the request could not be built");

    // And the covered one is not. A resolver in the path's own scope
    // resolves the probe, and a rule that asked about it anyway would be a
    // rule that fights correct code.
    expect(
      leaks.offenders.join(" | "),
      "a resolver in the path's own scope resolves the path's probe",
    ).not.toContain("the provider refused the request");
  });

  it("does not count a resolver that is only mentioned in a comment", () => {
    // A mention is not a call. A scan that counts mentions can be
    // satisfied by writing a sentence — and a leftover comment can mask a
    // path that really does leak the probe: the sentence is in the scope,
    // the scope matches, and the path is reported as covered when nothing
    // covers it.
    //
    // The two scans are both affected, and for the same reason: the
    // success-path scan looks for a resolver inside a success block, and
    // the path scan looks for one inside the path's scope. A comment can
    // sit in either.
    //
    // And a path that was commented out is not a path at all: the request
    // cannot take it. The fixture carries one, at the top of the function,
    // where nothing above it could cover it — so the only thing that
    // could report it as covered is a mention.
    const FIXTURES = path.join(process.cwd(), "tests", "unit", "fixtures");
    const file = path.join(FIXTURES, "probe-comment-resolver.js");
    const source = fs.readFileSync(file, "utf8");

    const leaks = probeLeaksIn("probe-comment-resolver.js", source);
    expect(
      leaks.offenders.length,
      `exactly one path is reported: the real one, and not the commented-out one — ${leaks.offenders.join(" | ")}`,
    ).toBe(1);
    expect(
      leaks.offenders[0],
      "the path that is reported is the one the request can actually take",
    ).toContain("The request could not be built");

    const successLeaks = successProbeLeaksIn("probe-comment-resolver.js", source);
    expect(
      successLeaks,
      "a resolver that is only mentioned in a comment does not resolve the probe on the success path",
    ).not.toEqual([]);
  });
});
