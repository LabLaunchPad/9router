/**
 * RTK Strict Mode Verification Tests
 *
 * RTK components are fail-open by convention: any error returns null and
 * leaves the request body untouched. Strict mode is an opt-in diagnostic
 * (RTK_STRICT=true, or the per-call `rtkStrict` argument) that makes the
 * same errors propagate so they surface instead of being swallowed.
 *
 * This file is plain JavaScript — it must parse under `node --check` and
 * under the Vitest transform without a TypeScript plugin.
 *
 * @see ADR-006
 */

import { describe, it, expect } from "vitest";
import { rtkStrict, RTK_STRICT_MODE } from "../../open-sse/config/runtimeConfig.js";
import { compressWithHeadroom } from "../../open-sse/rtk/headroom.js";
import { injectCaveman } from "../../open-sse/rtk/caveman.js";
import { injectPonytail } from "../../open-sse/rtk/ponytail.js";
import { safeApply } from "../../open-sse/rtk/applyFilter.js";
import { CAVEMAN_LEVELS } from "../../open-sse/rtk/cavemanPrompts.js";
import { PONYTAIL_LEVELS } from "../../open-sse/rtk/ponytailPrompt.js";

// --- helpers ---------------------------------------------------------------

/**
 * A body whose `messages` array is frozen. ES modules are always in strict
 * mode, so writing to it throws a TypeError — the exact failure the
 * fail-open path has to swallow.
 */
function frozenBody() {
  return Object.freeze({
    messages: Object.freeze([
      Object.freeze({ role: "user", content: "Hello" }),
    ]),
  });
}

function openBody() {
  return { messages: [{ role: "user", content: "Hello" }] };
}

// --- configuration ---------------------------------------------------------

describe("RTK strict mode configuration", () => {
  it("defaults to fail-open", () => {
    expect(RTK_STRICT_MODE).toBe(false);
    expect(rtkStrict).toBe(false);
  });

  it("exposes the env var as the source of truth", () => {
    // The exported constants are captured at import time, so this asserts the
    // documented contract rather than mutating the module.
    expect(typeof RTK_STRICT_MODE).toBe("boolean");
    expect(rtkStrict).toBe(RTK_STRICT_MODE);
  });
});

// --- safeApply -------------------------------------------------------------

describe("safeApply", () => {
  it("passes raw output through when the filter is not callable", () => {
    expect(safeApply(null, "some text")).toBe("some text");
    expect(safeApply("not-a-function", "some text")).toBe("some text");
  });

  it("passes raw output through when the filter returns a non-string", () => {
    expect(safeApply(() => 42, "some text")).toBe("some text");
  });

  it("fails open when a filter panics", () => {
    const boom = () => {
      throw new Error("filter panic");
    };
    boom.filterName = "boom-filter";
    expect(safeApply(boom, "some text")).toBe("some text");
  });

  it("propagates the error in strict mode", () => {
    const boom = () => {
      throw new Error("filter panic");
    };
    boom.filterName = "boom-filter";
    expect(() => safeApply(boom, "some text", true)).toThrow(/filter panic/);
  });

  it("returns the filter output on success", () => {
    expect(safeApply((t) => t.toUpperCase(), "some text")).toBe("SOME TEXT");
  });
});

// --- injectCaveman / injectPonytail ----------------------------------------

describe("injectCaveman", () => {
  it("does not throw on an unmutatable body in fail-open mode", () => {
    expect(() => injectCaveman(frozenBody(), "openai", CAVEMAN_LEVELS.LITE)).not.toThrow();
  });

  it("does not throw on an unmutatable body when strict is explicitly off", () => {
    expect(() => injectCaveman(frozenBody(), "openai", CAVEMAN_LEVELS.LITE, false)).not.toThrow();
  });

  it("propagates the error in strict mode", () => {
    expect(() => injectCaveman(frozenBody(), "openai", CAVEMAN_LEVELS.LITE, true)).toThrow();
  });

  it("injects the instruction into a mutable body", () => {
    const body = openBody();
    injectCaveman(body, "openai", CAVEMAN_LEVELS.LITE);
    expect(body.messages.length).toBe(2);
    expect(body.messages[0].role).toBe("system");
  });

  it("is idempotent — a second injection does not duplicate the prompt", () => {
    const body = openBody();
    injectCaveman(body, "openai", CAVEMAN_LEVELS.LITE);
    const afterFirst = JSON.stringify(body);
    injectCaveman(body, "openai", CAVEMAN_LEVELS.LITE);
    expect(JSON.stringify(body)).toBe(afterFirst);
  });
});

describe("injectPonytail", () => {
  it("does not throw on an unmutatable body in fail-open mode", () => {
    expect(() => injectPonytail(frozenBody(), "openai", PONYTAIL_LEVELS.LITE)).not.toThrow();
  });

  it("propagates the error in strict mode", () => {
    expect(() => injectPonytail(frozenBody(), "openai", PONYTAIL_LEVELS.LITE, true)).toThrow();
  });

  it("injects the instruction into a mutable body", () => {
    const body = openBody();
    injectPonytail(body, "openai", PONYTAIL_LEVELS.LITE);
    expect(body.messages.length).toBe(2);
    expect(body.messages[0].role).toBe("system");
  });
});

// --- compressWithHeadroom --------------------------------------------------

describe("compressWithHeadroom", () => {
  const testBody = {
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ],
    tools: [],
  };

  const badOptions = {
    enabled: true,
    url: "http://127.0.0.1:9/v1/compress",
    model: "gpt-4",
    format: "openai",
  };

  it("fails open when the proxy is unreachable", async () => {
    const result = await compressWithHeadroom(testBody, { ...badOptions });
    expect(result).toBeNull();
  });

  it("propagates an unexpected error in strict mode", async () => {
    // A body that throws on any property access makes the Claude translation
    // step fail with something that is not a normal "proxy unavailable".
    const explodingBody = new Proxy(
      {},
      {
        get() {
          throw new Error("body exploded");
        },
      },
    );

    await expect(
      compressWithHeadroom(explodingBody, { ...badOptions, format: "claude", rtkStrict: true }),
    ).rejects.toThrow(/body exploded/);
  });

  it("fails open on the same unexpected error when strict is off", async () => {
    const explodingBody = new Proxy(
      {},
      {
        get() {
          throw new Error("body exploded");
        },
      },
    );

    const result = await compressWithHeadroom(explodingBody, { ...badOptions, format: "claude" });
    expect(result).toBeNull();
  });

  it("is a no-op when disabled", async () => {
    const result = await compressWithHeadroom(testBody, { ...badOptions, enabled: false });
    expect(result).toBeNull();
  });
});
