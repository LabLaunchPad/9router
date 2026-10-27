// Tracing must be inert unless explicitly configured. These cases pin that
// contract: an unconfigured or half-configured environment has to leave the
// process untouched, because the same image also runs as a desktop tray binary
// where an outbound exporter is a defect, not a feature.
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const { resolveTracingConfig, parseOtlpHeaders, startTracing, stopTracing, __resetTracingForTests } =
  await import("../../src/lib/telemetry/tracing.js");

describe("tracing configuration resolution", () => {
  beforeEach(() => {
    __resetTracingForTests();
  });

  it("is disabled when OTEL_ENABLED is absent", () => {
    const config = resolveTracingConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/v1/traces" });

    expect(config.enabled).toBe(false);
    expect(config.reason).toContain("OTEL_ENABLED");
  });

  it("is disabled when the switch is on but no endpoint is set", () => {
    const config = resolveTracingConfig({ OTEL_ENABLED: "1" });

    expect(config.enabled).toBe(false);
    expect(config.reason).toContain("endpoint");
  });

  it("treats a falsy switch value as disabled", () => {
    expect(resolveTracingConfig({ OTEL_ENABLED: "0", OTEL_EXPORTER_OTLP_ENDPOINT: "http://x/v1/traces" }).enabled).toBe(false);
    expect(resolveTracingConfig({ OTEL_ENABLED: "false", OTEL_EXPORTER_OTLP_ENDPOINT: "http://x/v1/traces" }).enabled).toBe(false);
  });

  it("enables on OTEL_ENABLED=1 with an endpoint", () => {
    const config = resolveTracingConfig({
      OTEL_ENABLED: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://api.honeycomb.io/v1/traces",
      OTEL_SERVICE_NAME: "9router",
      OTEL_DEPLOYMENT_ENVIRONMENT: "production",
    });

    expect(config.enabled).toBe(true);
    expect(config.endpoint).toBe("https://api.honeycomb.io/v1/traces");
    expect(config.serviceName).toBe("9router");
    expect(config.environment).toBe("production");
  });

  it("prefers the traces-specific endpoint over the generic one", () => {
    // The OTel spec gives OTEL_EXPORTER_OTLP_TRACES_ENDPOINT precedence; a
    // backend configured through the specific var must not be overridden.
    const config = resolveTracingConfig({
      OTEL_ENABLED: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://generic.example/otlp",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://specific.example/v1/traces",
    });

    expect(config.endpoint).toBe("https://specific.example/v1/traces");
  });

  it("defaults the service name and sample ratio", () => {
    const config = resolveTracingConfig({ OTEL_ENABLED: "1", OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/v1/traces" });

    expect(config.serviceName).toBe("9router");
    expect(config.sampleRatio).toBe(0.1);
  });

  it("clamps an out-of-range sample ratio to the default", () => {
    const over = resolveTracingConfig({
      OTEL_ENABLED: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/v1/traces",
      OTEL_TRACES_SAMPLER_ARG: "5",
    });
    const nonsense = resolveTracingConfig({
      OTEL_ENABLED: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/v1/traces",
      OTEL_TRACES_SAMPLER_ARG: "not-a-number",
    });

    expect(over.sampleRatio).toBe(0.1);
    expect(nonsense.sampleRatio).toBe(0.1);
  });

  it("accepts the boundary sample ratios", () => {
    const zero = resolveTracingConfig({
      OTEL_ENABLED: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/v1/traces",
      OTEL_TRACES_SAMPLER_ARG: "0",
    });
    const one = resolveTracingConfig({
      OTEL_ENABLED: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318/v1/traces",
      OTEL_TRACES_SAMPLER_ARG: "1",
    });

    expect(zero.sampleRatio).toBe(0);
    expect(one.sampleRatio).toBe(1);
  });
});

describe("OTLP header parsing", () => {
  it("parses comma-separated key=value pairs", () => {
    expect(parseOtlpHeaders("x-honeycomb-team=abc, x-other=def")).toEqual({
      "x-honeycomb-team": "abc",
      "x-other": "def",
    });
  });

  it("keeps '=' inside a value (base64 credentials contain them)", () => {
    const parsed = parseOtlpHeaders("Authorization=Basic dXNlcjpwYXNz==");

    expect(parsed).toEqual({ Authorization: "Basic dXNlcjpwYXNz==" });
  });

  it("returns undefined for empty or malformed input", () => {
    expect(parseOtlpHeaders("")).toBeUndefined();
    expect(parseOtlpHeaders(undefined)).toBeUndefined();
    expect(parseOtlpHeaders("no-equals-sign")).toBeUndefined();
  });
});

describe("startTracing no-op path", () => {
  beforeEach(() => {
    __resetTracingForTests();
  });

  // The success case below really does start a NodeSDK. Shut it down so the
  // batch processor and its instrumented hooks do not outlive the test.
  afterEach(async () => {
    await stopTracing(1000);
    __resetTracingForTests();
  });

  it("does not start and does not touch the network when unconfigured", async () => {
    const result = await startTracing({});

    expect(result.started).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("reports already-started on a second successful call", async () => {
    // Point at a reserved-documentation address: nothing is listening, and the
    // batch processor never exports during this test, so no traffic is sent.
    const env = {
      OTEL_ENABLED: "1",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9/v1/traces",
      OTEL_TRACES_SAMPLER_ARG: "0",
    };

    const first = await startTracing(env);
    const second = await startTracing(env);

    expect(first.started).toBe(true);
    expect(second.started).toBe(true);
    expect(second.reason).toBe("already started");
  });
});
