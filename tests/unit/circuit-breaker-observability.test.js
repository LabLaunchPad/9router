/**
 * The circuit breaker's transitions have to be OBSERVABLE.
 *
 * A breaker that opens and closes silently is a control that cannot be
 * audited. The state gauge published by /api/metrics is a snapshot of a
 * moment: it cannot say when the circuit opened, how long it stayed open, or
 * whether the provider has been flapping between open and half-open.
 *
 * These tests assert the two things the branch's own rule asks for on every
 * failure mode — a structured log line and a metric — and they assert that
 * they are emitted on a TRANSITION, not on every failure: a provider that
 * fails once with a threshold of two has not changed state, and a log line
 * per failure would bury the line that matters.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  getCircuitBreaker,
  resetAllCircuitBreakers,
} from "../../open-sse/services/circuitBreaker.js";
import { getMetricsSnapshot, resetMetrics } from "../../src/sse/services/metrics.js";

const PROVIDER = "9router-breaker-observability";

function breaker(overrides = {}) {
  return getCircuitBreaker(PROVIDER, {
    failureThreshold: 2,
    coolDownWindowMs: 0,
    resetWindowMs: 2000,
    ...overrides,
  });
}

let captured = [];
let spies = [];

beforeEach(() => {
  resetAllCircuitBreakers();
  resetMetrics();
  captured = [];
  const collect = (line) => {
    captured.push(String(line));
  };
  spies = [
    vi.spyOn(console, "warn").mockImplementation(collect),
    vi.spyOn(console, "log").mockImplementation(collect),
    vi.spyOn(console, "error").mockImplementation(collect),
  ];
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  resetAllCircuitBreakers();
  resetMetrics();
});

/** The structured breaker records, parsed. */
function breakerRecords() {
  return captured
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((record) => record && String(record.event || "").startsWith("sse_circuit_breaker_"));
}

function transitions() {
  return getMetricsSnapshot().counters;
}

describe("the circuit breaker announces its transitions", () => {
  it("says nothing until the state actually changes", () => {
    const cb = breaker();
    cb.recordFailure();

    // One failure with a threshold of two is not a transition.
    expect(breakerRecords()).toHaveLength(0);
    expect(
      transitions()["sse_circuit_breaker_transitions_total{provider=\"9router-breaker-observability\",to=\"open\"}"],
    ).toBeUndefined();
  });

  it("logs and counts the opening of the circuit", () => {
    const cb = breaker();
    cb.recordFailure();
    cb.recordFailure();

    const records = breakerRecords();
    expect(records).toHaveLength(1);
    expect(records[0].event).toBe("sse_circuit_breaker_open");
    expect(records[0].level).toBe("warn");
    expect(records[0].provider).toBe(PROVIDER);
    expect(records[0].from).toBe("closed");
    expect(records[0].to).toBe("open");
    expect(records[0].failureCount).toBe(2);
    expect(records[0].failureThreshold).toBe(2);

    expect(
      transitions()["sse_circuit_breaker_transitions_total{provider=\"9router-breaker-observability\",to=\"open\"}"],
    ).toBe(1);
  });

  it("logs and counts the half-open probe and the closing", () => {
    const cb = breaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.canRequest(); // the cool-down has elapsed: the circuit half-opens
    cb.recordSuccess(); // the probe succeeded: the circuit closes

    const events = breakerRecords().map((record) => record.event);
    expect(events).toEqual([
      "sse_circuit_breaker_open",
      "sse_circuit_breaker_half_open",
      "sse_circuit_breaker_closed",
    ]);

    const counters = transitions();
    expect(
      counters["sse_circuit_breaker_transitions_total{provider=\"9router-breaker-observability\",to=\"open\"}"],
    ).toBe(1);
    expect(
      counters["sse_circuit_breaker_transitions_total{provider=\"9router-breaker-observability\",to=\"half-open\"}"],
    ).toBe(1);
    expect(
      counters["sse_circuit_breaker_transitions_total{provider=\"9router-breaker-observability\",to=\"closed\"}"],
    ).toBe(1);
  });

  it("logs and counts a failed half-open probe", () => {
    const cb = breaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.canRequest();
    cb.recordFailure(); // the probe failed: the circuit re-opens

    const opens = breakerRecords().filter((record) => record.event === "sse_circuit_breaker_open");
    expect(opens).toHaveLength(2);
    expect(opens[1].from).toBe("half-open");
    expect(opens[1].to).toBe("open");
    expect(opens[1].reason).toBe("the half-open probe failed");
  });
});
