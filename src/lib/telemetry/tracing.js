/**
 * Distributed tracing — vendor-neutral OpenTelemetry over OTLP/HTTP.
 *
 * Design notes (why it looks like this):
 *
 * 1. No vendor SDK. The export path is plain OTLP, which Honeycomb, Datadog,
 *    Grafana Cloud (Tempo), New Relic and a self-hosted collector all accept.
 *    Choosing a backend is then an env change, not a code change, and a future
 *    provider decision does not strand the instrumentation.
 *
 * 2. Everything is opt-in. With no endpoint configured, `startTracing()`
 *    returns immediately and the process behaves exactly as it did before: no
 *    spans are created, no background exporter runs, no network egress. That
 *    matters because this app also runs as a desktop tray binary and in
 *    Docker images where an exporter that phones home is a defect.
 *
 * 3. It never throws. Tracing is diagnostic; a broken exporter configuration
 *    must not take the router down. Every failure path logs a warning and
 *    leaves the app running untraced.
 *
 * Configuration (standard OpenTelemetry env vars, so existing docs apply):
 *
 *   OTEL_ENABLED=1                          # required switch
 *   OTEL_EXPORTER_OTLP_ENDPOINT=...         # trace endpoint (see presets below)
 *   OTEL_EXPORTER_OTLP_HEADERS=k=v,k2=v2    # auth headers
 *   OTEL_SERVICE_NAME=9router               # default: 9router
 *   OTEL_TRACES_SAMPLER_ARG=0.1             # head sample ratio, default 0.1
 *   OTEL_RESOURCE_ATTRIBUTES=...            # extra resource attributes
 *
 * Provider presets:
 *
 *   Honeycomb   OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces
 *               OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=<API_KEY>
 *               (EU: https://api.eu1.honeycomb.io/v1/traces)
 *
 *   Datadog     OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.<DD_SITE>/v1/traces
 *               OTEL_EXPORTER_OTLP_HEADERS=dd-api-key=<API_KEY>
 *               (DD_SITE is e.g. datadoghq.com or datadoghq.eu)
 *
 *   Grafana     OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-<zone>.grafana.net/otlp/v1/traces
 *               OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64(instance:token)>
 *
 *   Collector   OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318/v1/traces
 *
 * Local staging default: point at a collector on the Docker network rather
 * than a vendor, so a staging run does not ship data to production.
 */

const DEFAULT_SERVICE_NAME = '9router';
const DEFAULT_SAMPLE_RATIO = 0.1;

/** Parse `k=v,k2=v2` into a headers object. Tolerates spaces and empty pairs. */
export function parseOtlpHeaders(raw) {
  if (!raw) return undefined;
  const headers = {};
  for (const pair of String(raw).split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) headers[key] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/** Resolve the effective tracing config from the environment. */
export function resolveTracingConfig(env = process.env) {
  const enabled = String(env.OTEL_ENABLED || '').toLowerCase();
  const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT || '';

  if (enabled !== '1' && enabled !== 'true') {
    return { enabled: false, reason: 'OTEL_ENABLED is not set to 1/true' };
  }
  if (!endpoint) {
    return { enabled: false, reason: 'no OTLP endpoint configured' };
  }

  const ratioRaw = env.OTEL_TRACES_SAMPLER_ARG;
  const parsedRatio = ratioRaw === undefined ? DEFAULT_SAMPLE_RATIO : Number(ratioRaw);
  const ratio = Number.isFinite(parsedRatio) && parsedRatio >= 0 && parsedRatio <= 1
    ? parsedRatio
    : DEFAULT_SAMPLE_RATIO;

  return {
    enabled: true,
    endpoint,
    headers: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    serviceName: env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME,
    // `deployment.environment.name` is the current semantic-convention key;
    // the older `deployment.environment` is what most backends still group on,
    // so both are set rather than betting on which one the backend reads.
    environment: env.OTEL_DEPLOYMENT_ENVIRONMENT || env.NODE_ENV || 'development',
    sampleRatio: ratio,
    verbose: env.OTEL_DEBUG === '1',
  };
}

let started = false;
let sdkRef = null;

/**
 * Start the OpenTelemetry NodeSDK. Safe to call more than once; the second
 * call is a no-op. Never throws.
 *
 * @returns {Promise<{started: boolean, reason?: string}>}
 */
export async function startTracing(env = process.env) {
  if (started) return { started: true, reason: 'already started' };

  const config = resolveTracingConfig(env);
  if (!config.enabled) {
    if (config.verbose || env.OTEL_DEBUG === '1') {
      console.info(`[tracing] disabled: ${config.reason}`);
    }
    return { started: false, reason: config.reason };
  }

  try {
    const [
      { NodeSDK },
      { OTLPTraceExporter },
      { resourceFromAttributes },
      { ParentBasedSampler, TraceIdRatioBasedSampler },
      { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
      { getNodeAutoInstrumentations },
    ] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/sdk-trace-base'),
      import('@opentelemetry/semantic-conventions'),
      import('@opentelemetry/auto-instrumentations-node'),
    ]);

    const serviceVersion = env.npm_package_version || env.APP_VERSION || 'unknown';

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: config.serviceName,
        [ATTR_SERVICE_VERSION]: serviceVersion,
        'deployment.environment.name': config.environment,
        'deployment.environment': config.environment,
      }),
      traceExporter: new OTLPTraceExporter({
        url: config.endpoint,
        headers: config.headers,
      }),
      // Parent-based so a sampled inbound request keeps its trace: the ratio
      // only decides NEW roots. A trace that enters already sampled must not
      // be truncated halfway through this service.
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(config.sampleRatio),
      }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Every span on a busy router touches fs; the volume drowns the
          // HTTP/undici spans that actually answer "where did this request go".
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    });

    sdk.start();
    started = true;
    sdkRef = sdk;

    const shutdown = () => {
      // flush with a bound, then continue exiting. An unflushed batch on
      // shutdown is a lost trace, but a hung shutdown is a wedged container.
      Promise.race([
        sdk.shutdown(),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ])
        .catch(() => {})
        .finally(() => process.exit(0));
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);

    console.info(
      `[tracing] started service=${config.serviceName} env=${config.environment} ` +
        `sample=${config.sampleRatio} endpoint=${config.endpoint}`,
    );
    return { started: true };
  } catch (error) {
    // Missing packages, malformed endpoint, bad header — all the same from the
    // app's point of view: run untraced, say why once.
    console.warn(`[tracing] not started: ${error?.message || error}`);
    return { started: false, reason: error?.message || String(error) };
  }
}

/** Test seam: lets a suite assert start-up behaviour without a real SDK. */
export function __resetTracingForTests() {
  started = false;
  sdkRef = null;
}

/**
 * Flush pending spans and shut the SDK down. Returns once the batch processor
 * has flushed or the bound elapses.
 *
 * Separate from the signal handler because callers that are not exiting — a
 * verification script, a test, a graceful server drain — need the flush without
 * the process.exit().
 */
export async function stopTracing(timeoutMs = 5000) {
  if (!sdkRef) return { stopped: false, reason: 'tracing never started' };
  const sdk = sdkRef;
  sdkRef = null;
  started = false;
  try {
    await Promise.race([
      sdk.shutdown(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    return { stopped: true };
  } catch (error) {
    return { stopped: false, reason: error?.message || String(error) };
  }
}
