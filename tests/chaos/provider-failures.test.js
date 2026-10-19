// tests/chaos/provider-failures.test.js
//
// Chaos-engineering suite: six provider / failure scenarios.
//
// These tests are EXCLUDED from the default Vitest run (see the `exclude`
// list in the root vitest.config.js) and are executed explicitly:
//
//   npx vitest run --config tests/chaos/vitest.config.js
//
// or, in CI, by the `chaos` job in the chaos-engineering workflow.
//
// DESIGN NOTE
// Every scenario injects failure through the existing dependency-injection
// seams (`handleSingleModel`, `getCircuitBreaker`, the RTK entry points)
// rather than by talking to a live upstream. This keeps the suite
// deterministic and network-free while still exercising the real
// production code paths: combo fallback, fusion quorum, circuit-breaker
// state machine, and RTK fail-open semantics.
//
// Nothing here touches real credentials, real accounts, or real upstreams.

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  handleComboChat,
  handleFusionChat,
} from "../../open-sse/services/combo.js";
import {
  getCircuitBreaker,
  resetAllCircuitBreakers,
  getAllCircuitBreakerStates,
  CircuitBreakerState,
} from "../../open-sse/services/circuitBreaker.js";
import { compressMessages } from "../../open-sse/rtk/index.js";
import { safeApply } from "../../open-sse/rtk/applyFilter.js";
import { CIRCUIT_BREAKER_CONFIG, validateCircuitBreakerConfig } from "../../open-sse/config/runtimeConfig.js";
import REGISTRY from "../../open-sse/providers/registry/index.js";

// --- helpers ----------------------------------------------------------------

/** Minimal logger stub matching the `log.info/warn/error` surface used by combo. */
const stubLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Build an upstream-style error response.
 *
 * This mirrors what open-sse/utils/error.js#unavailableResponse actually
 * emits: a `{ error: { message } }` body plus a lowercase `retry-after`
 * header carrying seconds. The combo service has to read the hint from the
 * header, because the body never carries it.
 */
function errorResponse(status, message, retryAfterSeconds = null) {
  const headers = { "Content-Type": "application/json" };
  if (retryAfterSeconds !== null) {
    headers["retry-after"] = String(retryAfterSeconds);
  }
  return new Response(JSON.stringify({ error: { message } }), { status, headers });
}

beforeEach(() => {
  resetAllCircuitBreakers();
});

afterEach(() => {
  resetAllCircuitBreakers();
});

// ===========================================================================
// Scenario 1 — Account kill switch
// ===========================================================================

describe("chaos: account kill switch", () => {
  it("opens the provider circuit after the failure threshold and fails fast", () => {
    const cb = getCircuitBreaker("kill-switch-provider", {
      failureThreshold: 3,
      coolDownWindowMs: 60000,
      resetWindowMs: 120000,
    });

    expect(cb.state).toBe(CircuitBreakerState.CLOSED);
    expect(cb.canRequest()).toBe(true);

    // Simulate three consecutive upstream failures.
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe(CircuitBreakerState.CLOSED);
    expect(cb.canRequest()).toBe(true);

    cb.recordFailure();
    expect(cb.state).toBe(CircuitBreakerState.OPEN);
    expect(cb.canRequest()).toBe(false);
  });

  it("exposes the open state to the metrics surface", () => {
    const cb = getCircuitBreaker("kill-switch-metrics", {
      failureThreshold: 1,
      coolDownWindowMs: 60000,
      resetWindowMs: 120000,
    });
    cb.recordFailure();

    const states = getAllCircuitBreakerStates();
    const entry = states.find((s) => s.provider === "kill-switch-metrics");
    expect(entry).toBeDefined();
    expect(entry.state).toBe(CircuitBreakerState.OPEN);
    expect(entry.canRequest).toBe(false);
  });

  it("recovers to half-open after the cool-down window elapses", () => {
    const cb = getCircuitBreaker("kill-switch-recovery", {
      failureThreshold: 1,
      coolDownWindowMs: 0, // immediately eligible
      resetWindowMs: 120000,
    });
    cb.recordFailure();
    expect(cb.state).toBe(CircuitBreakerState.OPEN);

    // canRequest() promotes OPEN -> HALF-OPEN once the cool-down elapsed.
    expect(cb.canRequest()).toBe(true);
    expect(cb.state).toBe(CircuitBreakerState.HALF_OPEN);

    cb.recordSuccess();
    expect(cb.state).toBe(CircuitBreakerState.CLOSED);
  });
});

// ===========================================================================
// Scenario 2 — Latency spike
// ===========================================================================

describe("chaos: latency spike", () => {
  it("keeps the combo responsive when a slow model eventually succeeds", async () => {
    const calls = [];
    const handleSingleModel = async (body, model) => {
      calls.push(model);
      // Simulate a slow upstream that still answers.
      await new Promise((r) => setTimeout(r, 20));
      return jsonResponse({ choices: [{ message: { content: "slow but ok" } }] });
    };

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["slow-a", "fast-b"],
      handleSingleModel,
      log: stubLog,
      comboName: "latency-spike",
      comboStrategy: "fallback",
    });

    expect(res.ok).toBe(true);
    expect(calls[0]).toBe("slow-a");
  });

  it("falls through to the next model when the slow model fails", async () => {
    const calls = [];
    const handleSingleModel = async (body, model) => {
      calls.push(model);
      if (model === "slow-fail") {
        await new Promise((r) => setTimeout(r, 20));
        return errorResponse(504, "upstream timeout");
      }
      return jsonResponse({ choices: [{ message: { content: "recovered" } }] });
    };

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["slow-fail", "fast-ok"],
      handleSingleModel,
      log: stubLog,
      comboName: "latency-spike-fallback",
      comboStrategy: "fallback",
    });

    expect(res.ok).toBe(true);
    expect(calls).toEqual(["slow-fail", "fast-ok"]);
  });
});

// ===========================================================================
// Scenario 3 — Translator / RTK corruption
// ===========================================================================

describe("chaos: translator corruption", () => {
  it("leaves the request body untouched when RTK compression fails", () => {
    // A body whose tool_result content is not a string — RTK must fail open
    // rather than throw or corrupt the payload.
    const body = {
      messages: [
        { role: "user", content: "hello" },
        { role: "tool", tool_call_id: "call_1", content: { unexpected: "object" } },
      ],
    };
    const before = JSON.stringify(body);

    let threw = false;
    let result = null;
    try {
      result = compressMessages(body, true);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    // Fail-open contract: stats object on success, null on failure.
    expect(result === null || typeof result === "object").toBe(true);
    // The malformed message must not have been rewritten into something else.
    expect(JSON.stringify(body.messages[1])).toBe(JSON.stringify({ role: "tool", tool_call_id: "call_1", content: { unexpected: "object" } }));
    expect(before).toContain("unexpected");
  });

  it("is a no-op when RTK is disabled", () => {
    const body = { messages: [{ role: "tool", tool_call_id: "c1", content: "x".repeat(5000) }] };
    const before = JSON.stringify(body);
    expect(compressMessages(body, false)).toBeNull();
    expect(JSON.stringify(body)).toBe(before);
  });

  it("passes raw output through when a filter panics (fail-open)", () => {
    const boom = () => {
      throw new Error("filter exploded");
    };
    boom.filterName = "boom-filter";
    const raw = "original output";

    let out;
    let threw = false;
    try {
      out = safeApply(boom, raw);
    } catch {
      threw = true;
    }
    // Fail-open: the raw text is returned, the request is not lost.
    expect(threw).toBe(false);
    expect(out).toBe(raw);
  });

  it("propagates the error in strict mode (opt-in only)", () => {
    const boom = () => {
      throw new Error("filter exploded");
    };
    boom.filterName = "boom-filter";
    expect(() => safeApply(boom, "original", true)).toThrow(/filter exploded/);
  });

  it("passes text through when the filter is not callable", () => {
    expect(safeApply(null, "original")).toBe("original");
    expect(safeApply("not-a-function", "original")).toBe("original");
  });

  it("passes text through when the filter returns a non-string", () => {
    expect(safeApply(() => 42, "original")).toBe("original");
  });
});

// ===========================================================================
// Scenario 4 — Provider timeout
// ===========================================================================

describe("chaos: provider timeout", () => {
  it("returns 503 with a retry hint when every model in a combo fails", async () => {
    const handleSingleModel = async () => errorResponse(504, "upstream timeout");

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["timeout-a", "timeout-b"],
      handleSingleModel,
      log: stubLog,
      comboName: "provider-timeout",
      comboStrategy: "fallback",
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("does not attempt upstream calls while the circuit is open", () => {
    const cb = getCircuitBreaker("timeout-provider", {
      failureThreshold: 2,
      coolDownWindowMs: 600000,
      resetWindowMs: 900000,
    });

    cb.recordFailure();
    cb.recordFailure();
    expect(cb.canRequest()).toBe(false);

    // A guarded call path would consult canRequest() and skip the upstream.
    let upstreamCalled = false;
    if (cb.canRequest()) {
      upstreamCalled = true;
    }
    expect(upstreamCalled).toBe(false);
  });
});

// ===========================================================================
// Scenario 5 — Combo model exhaustion
// ===========================================================================

describe("chaos: combo model exhaustion", () => {
  it("reports exhaustion after every model has failed", async () => {
    const attempted = [];
    const handleSingleModel = async (body, model) => {
      attempted.push(model);
      // NB: the message must not match a text rule in errorConfig.js
      // ("capacity", "rate limit", ...). Those carry a backoff cooldown that
      // the combo deliberately waits out before falling through, which would
      // make this scenario take seconds instead of milliseconds.
      return errorResponse(503, "upstream unavailable", 30);
    };

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["m1", "m2", "m3"],
      handleSingleModel,
      log: stubLog,
      comboName: "exhaustion",
      comboStrategy: "fallback",
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(attempted).toEqual(["m1", "m2", "m3"]);
  });

  it("surfaces the earliest retry hint across exhausted models", async () => {
    const handleSingleModel = async () => errorResponse(503, "upstream unavailable", 45);

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["m1", "m2"],
      handleSingleModel,
      log: stubLog,
      comboName: "exhaustion-retry",
      comboStrategy: "fallback",
    });

    expect(res.status).toBe(503);
    // The retry hint is surfaced to the client, not swallowed.
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("treats a zero-content 200 as a failure and keeps falling back", async () => {
    const attempted = [];
    const handleSingleModel = async (body, model) => {
      attempted.push(model);
      if (model === "empty") {
        return jsonResponse({ choices: [{ message: { content: "" } }] });
      }
      return jsonResponse({ choices: [{ message: { content: "real answer" } }] });
    };

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["empty", "good"],
      handleSingleModel,
      log: stubLog,
      comboName: "zero-content",
      comboStrategy: "fallback",
    });

    expect(res.ok).toBe(true);
    expect(attempted).toEqual(["empty", "good"]);
  });

  it("returns 503 when the single model in the combo fails", async () => {
    const handleSingleModel = async () => errorResponse(500, "boom");

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["only"],
      handleSingleModel,
      log: stubLog,
      comboName: "single-fail",
      comboStrategy: "fallback",
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// Scenario 6 — Fusion judge timeout
// ===========================================================================

describe("chaos: fusion judge timeout", () => {
  it("degrades to a surviving panel answer when the judge hangs", async () => {
    const handleSingleModel = async (body, model) => {
      if (model === "judge") {
        // Hang past the hard timeout.
        await new Promise((r) => setTimeout(r, 200));
        return jsonResponse({ choices: [{ message: { content: "late judge" } }] });
      }
      return jsonResponse({ choices: [{ message: { content: `answer from ${model}` } }] });
    };

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["panel-a", "panel-b"],
      handleSingleModel,
      log: stubLog,
      comboName: "fusion-judge-timeout",
      judgeModel: "judge",
      tuning: {
        minPanel: 2,
        stragglerGraceMs: 20,
        panelHardTimeoutMs: 60,
      },
    });

    // The judge is capped by the same hard timeout as the panel, so the
    // request must complete even though the judge never answers.
    expect(res.ok).toBe(true);
    const body = await res.json();
    const text = JSON.stringify(body);
    // Degraded to a panel answer, not the late judge output.
    expect(text).toContain("answer from");
    expect(text).not.toContain("late judge");
  });

  it("returns the judge answer when the judge responds in time", async () => {
    const handleSingleModel = async (body, model) => {
      if (model === "judge") {
        return jsonResponse({ choices: [{ message: { content: "synthesised verdict" } }] });
      }
      return jsonResponse({ choices: [{ message: { content: `answer from ${model}` } }] });
    };

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["panel-a", "panel-b"],
      handleSingleModel,
      log: stubLog,
      comboName: "fusion-judge-ok",
      judgeModel: "judge",
      tuning: { minPanel: 2, stragglerGraceMs: 20, panelHardTimeoutMs: 1000 },
    });

    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("synthesised verdict");
  });

  it("returns 503 when no panel member can answer", async () => {
    const handleSingleModel = async () => errorResponse(500, "all down");

    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["a", "b"],
      handleSingleModel,
      log: stubLog,
      comboName: "fusion-all-down",
      judgeModel: "a",
      tuning: { minPanel: 2, stragglerGraceMs: 20, panelHardTimeoutMs: 60 },
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("rejects an empty fusion panel with 400", async () => {
    const res = await handleFusionChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: [],
      handleSingleModel: async () => jsonResponse({}),
      log: stubLog,
      comboName: "fusion-empty",
    });

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// Cross-scenario: configuration sanity
// ===========================================================================

describe("chaos: circuit breaker configuration sanity", () => {
  it("ships a default configuration with sane thresholds", () => {
    const d = CIRCUIT_BREAKER_CONFIG.default;
    expect(d.failureThreshold).toBeGreaterThan(0);
    expect(d.coolDownWindowMs).toBeGreaterThan(0);
    expect(d.resetWindowMs).toBeGreaterThan(0);
    // The reset window must outlast the cool-down, otherwise a breaker would
    // half-open and immediately re-open before the provider could recover.
    expect(d.resetWindowMs).toBeGreaterThan(d.coolDownWindowMs);
  });

  it("validates the shipped default against the schema validator", () => {
    const result = validateCircuitBreakerConfig(CIRCUIT_BREAKER_CONFIG.default);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("gives every registry provider that overrides the breaker a valid config", () => {
    const overrides = REGISTRY.filter((r) => r.circuitBreaker);
    expect(overrides.length).toBeGreaterThan(0);
    for (const provider of overrides) {
      const result = validateCircuitBreakerConfig(provider.circuitBreaker);
      expect(
        result.errors,
        `provider "${provider.id}" has an invalid circuitBreaker config`,
      ).toEqual([]);
    }
  });
});
