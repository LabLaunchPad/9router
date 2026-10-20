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
 */
const RESOLVERS = /\b(clearAccountError|recordProviderSuccess|markAccountUnavailable|releaseProviderProbe)\s*\(/;

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
      if (!RESOLVERS.test(source)) offenders.push(file);
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
   */
  function isSuccessBlock(text) {
    if (/onRequestSuccess\s*:/.test(text)) return true;
    const m = text.match(/^(?:\}\s*else\s+)?if\s*\((.*)\)/);
    if (!m) return false;
    const cond = m[1];
    if (!/success/i.test(cond) && !/\.ok\b/.test(cond)) return false;
    if (/!\s*\w*success/i.test(cond)) return false;
    return true;
  }

  it("resolves the probe on the success path, not merely somewhere in the file", () => {
    // The check above is a presence proxy: a file that NAMES a resolver
    // but calls it only on its failure path passes it, and leaves exactly
    // the defect this file is about — a successful request whose probe
    // stays claimed. So the resolver is tied to the success path here.
    const SUCCESS_RESOLVERS = /\b(clearAccountError|recordProviderSuccess)\s*\(/;

    const offenders = [];
    for (const file of filesThatObtainCredentials()) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      const lines = source.split(/\r?\n/);

      let resolvedOnSuccess = false;
      lines.forEach((line, i) => {
        if (resolvedOnSuccess) return;
        if (!SUCCESS_RESOLVERS.test(line)) return;
        if (enclosingBlocks(lines, i).some(isSuccessBlock)) resolvedOnSuccess = true;
      });

      if (!resolvedOnSuccess) offenders.push(file);
    }

    // A resolver that is only reached on the failure path is as good as no
    // resolver at all: the success path is the one that leaves the probe
    // claimed, and it is the one that blackholes the provider.
    expect(
      offenders,
      `these files obtain credentials but do not resolve the breaker's probe on the success path: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * The body of the block a line sits in, as text.
   *
   * The block is the innermost one whose header is above the line, and its
   * body is the run of lines below that header which are indented deeper
   * than it. Brace counting is not used: the source is full of template
   * literals whose braces are not blocks.
   */
  function blockBodyAbove(lines, index) {
    let header = -1;
    let level = lines[index].search(/\S/);
    for (let j = index - 1; j >= 0; j -= 1) {
      const indent = lines[j].search(/\S/);
      if (indent < 0) continue;
      if (indent >= level) continue;
      if (lines[j].trim().endsWith("{")) {
        header = j;
        break;
      }
      level = indent;
    }
    if (header < 0) return "";

    const body = [];
    const headerLevel = lines[header].search(/\S/);
    for (let j = header + 1; j <= index; j += 1) {
      const indent = lines[j].search(/\S/);
      if (indent < 0) continue; // blank
      if (indent <= headerLevel) break; // the block ended
      body.push(lines[j]);
    }
    return body.join("\n");
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
    const offenders = [];

    for (const file of filesThatObtainCredentials()) {
      const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
      const lines = source.split(/\r?\n/);

      // The line the credential lookup is on: a response before it cannot
      // have claimed a probe, so it is not this check's business.
      const lookup = lines.findIndex((line) => /getProviderCredentials\s*\(/.test(line));
      if (lookup < 0) continue;

      lines.forEach((line, i) => {
        if (i <= lookup) return;
        // An error response with a literal 4xx status. The status is often
        // on a line of its own — a multi-line `Response.json(...)` call —
        // so the whole statement is read, not just the `return` line.
        if (!/return\s+(new\s+)?Response(\.json)?\s*\(/.test(line)) return;
        const statement = [line];
        for (let j = i + 1; j < lines.length && j <= i + 6; j += 1) {
          statement.push(lines[j]);
          if (lines[j].includes(";")) break;
        }
        if (!/\bstatus:\s*(400|401|403|404|406|409|422|499)\b/.test(statement.join("\n"))) return;

        const body = blockBodyAbove(lines, i);
        if (RESOLVERS.test(body)) return;

        offenders.push(`${file}:${i + 1}  ${line.trim()}`);
      });
    }

    expect(
      offenders,
      `these paths return an error after claiming the probe without releasing it: ${offenders.join(" | ")}`,
    ).toEqual([]);
  });
});
