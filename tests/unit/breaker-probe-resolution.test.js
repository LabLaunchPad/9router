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

const HANDLERS_DIR = path.join(process.cwd(), "src", "sse", "handlers");

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

describe("circuit breaker: every handler that claims the probe resolves it", () => {
  /**
   * The handlers that obtain provider credentials.
   *
   * A handler that is not in this list never calls `canRequest()`, so it
   * never claims a probe and owes nothing.
   */
  function handlersThatObtainCredentials() {
    const names = [];
    for (const entry of fs.readdirSync(HANDLERS_DIR, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      const source = fs.readFileSync(path.join(HANDLERS_DIR, entry.name), "utf8");
      if (/getProviderCredentials\s*\(/.test(source)) names.push(entry.name);
    }
    return names.sort();
  }

  it("finds the handlers that obtain credentials", () => {
    const handlers = handlersThatObtainCredentials();
    // If this list ever comes back empty the check below would pass
    // vacuously, so it is pinned.
    expect(handlers.length).toBeGreaterThan(0);
    expect(handlers).toContain("chat.js");
    expect(handlers).toContain("stt.js");
    expect(handlers).toContain("tts.js");
  });

  it("has no handler that claims the probe without a way to resolve it", () => {
    // `clearAccountError` records the success; `recordProviderSuccess` is
    // the narrower way to do the same. Either is a resolver.
    const RESOLVERS = /\b(clearAccountError|recordProviderSuccess)\s*\(/;

    const offenders = [];
    for (const name of handlersThatObtainCredentials()) {
      const source = fs.readFileSync(path.join(HANDLERS_DIR, name), "utf8");
      if (!RESOLVERS.test(source)) offenders.push(name);
    }

    // A handler that obtains credentials and never resolves the probe
    // leaves the provider half-open with its slot held after a successful
    // request, and every later request for that provider is refused for the
    // whole reset window.
    expect(
      offenders,
      `these handlers obtain credentials but never resolve the breaker's probe: ${offenders.join(", ")}`,
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
   */
  function isSuccessBlock(text) {
    if (/onRequestSuccess\s*:/.test(text)) return true;
    const m = text.match(/^(?:\}\s*else\s+)?if\s*\((.*)\)/);
    if (!m) return false;
    const cond = m[1];
    if (!/success/i.test(cond)) return false;
    if (/!\s*\w*success/i.test(cond)) return false;
    return true;
  }

  it("resolves the probe on the success path, not merely somewhere in the file", () => {
    // The check above is a presence proxy: a handler that NAMES a resolver
    // but calls it only on its failure path passes it, and leaves exactly
    // the defect this file is about — a successful request whose probe
    // stays claimed. So the resolver is tied to the success path here.
    const RESOLVERS = /\b(clearAccountError|recordProviderSuccess)\s*\(/;

    const offenders = [];
    for (const name of handlersThatObtainCredentials()) {
      const source = fs.readFileSync(path.join(HANDLERS_DIR, name), "utf8");
      const lines = source.split(/\r?\n/);

      let resolvedOnSuccess = false;
      lines.forEach((line, i) => {
        if (resolvedOnSuccess) return;
        if (!RESOLVERS.test(line)) return;
        if (enclosingBlocks(lines, i).some(isSuccessBlock)) resolvedOnSuccess = true;
      });

      if (!resolvedOnSuccess) offenders.push(name);
    }

    // A resolver that is only reached on the failure path is as good as no
    // resolver at all: the success path is the one that leaves the probe
    // claimed, and it is the one that blackholes the provider.
    expect(
      offenders,
      `these handlers obtain credentials but do not resolve the breaker's probe on the success path: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
