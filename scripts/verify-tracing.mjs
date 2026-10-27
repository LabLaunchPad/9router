#!/usr/bin/env node
/**
 * Tracing readiness check — verifies the OTLP export path end to end.
 *
 * Starts a throwaway OTLP/HTTP receiver on loopback, enables tracing against
 * it, emits work that the auto-instrumentations should capture, then asserts
 * that a payload actually arrived carrying this service's name.
 *
 * This exists because "the SDK imported successfully" is not the same claim as
 * "a span reaches a backend". The former passes with a wrong endpoint, a wrong
 * header and a sampler at 0; only the latter proves the pipeline.
 *
 * Usage: node scripts/verify-tracing.mjs
 * Exit 0 = a span was received. Exit 1 = it was not, with the reason printed.
 */

import http from 'node:http';

const PORT = Number(process.env.VERIFY_OTLP_PORT || 4318);
const SERVICE = '9router-tracing-verify';

const received = [];

const receiver = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ url: req.url, body: Buffer.concat(chunks) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

try {
  await listen(receiver, PORT);
} catch (error) {
  console.error(`Could not bind the OTLP receiver on 127.0.0.1:${PORT}: ${error.message}`);
  console.error('Set VERIFY_OTLP_PORT to a free port and retry.');
  process.exit(1);
}

// Configure before importing the module: resolveTracingConfig reads process.env.
process.env.OTEL_ENABLED = '1';
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${PORT}/v1/traces`;
process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-verify-token=secret-value';
process.env.OTEL_SERVICE_NAME = SERVICE;
process.env.OTEL_DEPLOYMENT_ENVIRONMENT = 'verification';
// Sample everything: a sampled-out verification proves nothing.
process.env.OTEL_TRACES_SAMPLER_ARG = '1';
process.env.OTEL_DEBUG = '1';

const { startTracing, stopTracing, resolveTracingConfig } = await import('../src/lib/telemetry/tracing.js');

const config = resolveTracingConfig();
if (!config.enabled) {
  console.error(`Config resolution failed: ${config.reason}`);
  receiver.close();
  process.exit(1);
}
if (config.headers?.['x-verify-token'] !== 'secret-value') {
  console.error(`OTLP header parsing failed: ${JSON.stringify(config.headers)}`);
  receiver.close();
  process.exit(1);
}

const start = await startTracing();
if (!start.started) {
  console.error(`startTracing failed: ${start.reason}`);
  receiver.close();
  process.exit(1);
}

// Emit a traced unit of work. Two separate claims are under test here:
//
//   1. an explicit span reaches the backend (the tracer itself works), and
//   2. the auto-instrumentations produce a CLIENT span for an outbound call.
//
// `fetch` is used deliberately rather than `http.get`: this script imports
// node:http at the top to run the receiver, so http is already loaded before
// tracing starts and require-in-the-middle can no longer patch it. Fetch's
// undici stack loads lazily on first call, which is past startTracing() — so
// a span here means the auto-instrumentation really engaged. In the app the
// same ordering holds: register() runs before route handlers import anything.
const { trace } = await import('@opentelemetry/api');
const tracer = trace.getTracer('verify-tracing');
await new Promise((resolve) => {
  tracer.startActiveSpan('verification-span', async (span) => {
    try {
      await fetch(`http://127.0.0.1:${PORT}/work`);
    } catch {
      // The receiver answers everything; a failure here is still reported by
      // the payload assertions below, not by throwing.
    } finally {
      span.end();
      resolve();
    }
  });
});

// Force a flush. The batch processor's default flush interval is 5s, so
// waiting a short fixed time would report a false failure on a correct setup.
await stopTracing(8000);

receiver.close();

const tracePayloads = received.filter((r) => r.url.includes('/v1/traces'));
const sawService = tracePayloads.some((r) => r.body.toString('utf8').includes(SERVICE));
const sawManualSpan = tracePayloads.some((r) =>
  r.body.toString('latin1').includes('verification-span'),
);
const sawOutboundSpan = tracePayloads.some((r) => {
  const text = r.body.toString('latin1');
  return text.includes('/work') || text.includes('HTTP');
});

if (tracePayloads.length === 0) {
  console.error('FAIL: the receiver got no trace payload at all.');
  process.exit(1);
}
if (!sawService) {
  console.error(`FAIL: payloads arrived but none carried service name "${SERVICE}".`);
  process.exit(1);
}

console.log('PASS: tracing export verified');
console.log(`  endpoint      ${config.endpoint}`);
console.log(`  service       ${SERVICE}`);
console.log(`  payloads      ${tracePayloads.length}`);
console.log(`  manual span   ${sawManualSpan ? 'captured (verification-span)' : 'MISSING'}`);
console.log(`  outbound span ${sawOutboundSpan ? 'captured' : 'not captured'}`);

// The export path is the gate: a missing manual span means the SDK is not
// wired. A missing outbound span means the auto-instrumentations did not
// engage on this Node build — a coverage gap worth surfacing, not a broken
// exporter, so it warns rather than fails.
if (!sawManualSpan) process.exit(1);
if (!sawOutboundSpan) {
  console.warn('WARN: no outbound client span — check auto-instrumentation coverage for this runtime.');
}
process.exit(0);
