# Circuit Breaker Verification Plan

## Overview
This plan verifies that per-provider circuit breaker configurations are properly loaded, merged with defaults, and used throughout the auth flow.

> **How to run these checks.**
>
> Everything under `open-sse/` and `src/` is an ES module, and some of these
> modules import through the `@/` path alias or through a bare `open-sse/`
> specifier. Node resolves neither: it cannot `require()` an ES module at all
> on Node 20, and it cannot resolve an alias that only the bundler knows.
>
> So a check that touches one of those modules has to run through the
> repository's own runner, which does resolve them:
>
> ```bash
> npx vitest run <file>
> ```
>
> A check that only touches a self-contained module can run under Node
> directly, with `--input-type=module` — the repository is CommonJS by
> default, and these files are ES modules.

## Verification Steps

### 1. Validate Config Schema
**Goal**: Ensure all circuitBreaker configs (default + provider overrides) pass validation.

```bash
# `open-sse/config/runtimeConfig.js` has no imports of its own, so Node can
# load it directly. `--input-type=module` is required: the repository is
# CommonJS by default and this file is an ES module.
node --input-type=module -e "
import { validateCircuitBreakerConfig, CIRCUIT_BREAKER_CONFIG } from './open-sse/config/runtimeConfig.js';

// Validate default
const defaultResult = validateCircuitBreakerConfig(CIRCUIT_BREAKER_CONFIG.default);
console.log('Default config valid:', defaultResult.valid);
if (!defaultResult.valid) console.log('Errors:', defaultResult.errors);

// Validate provider configs
for (const [id, config] of Object.entries(CIRCUIT_BREAKER_CONFIG.providers)) {
  const result = validateCircuitBreakerConfig(config);
  console.log(\`\${id} config valid:\`, result.valid);
  if (!result.valid) console.log('Errors:', result.errors);
}
"
```

**Expected**: All configs should be valid (`valid: true`). The default must pass with its values (failureThreshold: 5, coolDownWindowMs: 300000, resetWindowMs: 900000).

The validator's rules come from `CIRCUIT_BREAKER_SCHEMA` in the same file, so the schema and the validator cannot drift apart.

### 2. Verify Per-Provider Configs Are Loaded
**Goal**: Confirm that provider registry entries have circuitBreaker fields and they're correctly read.

```bash
# Check that registry entries have circuitBreaker
node --input-type=module -e "
import registry from './open-sse/providers/registry/index.js';
const providersWithCB = registry.filter(r => r.circuitBreaker);
console.log('Providers with circuitBreaker config:', providersWithCB.length);
providersWithCB.forEach(r => {
  console.log(\`  - \${r.id} (alias: \${r.alias}): failureThreshold=\${r.circuitBreaker?.failureThreshold}, coolDownWindowMs=\${r.circuitBreaker?.coolDownWindowMs}, resetWindowMs=\${r.circuitBreaker?.resetWindowMs}\`);
});
"
```

**Expected**: 5 providers (openai, anthropic, groq, gemini, together) should have circuitBreaker configs with per-provider overrides.

### 3. Verify Auth.js Uses Per-Provider CB Config
**Goal**: Confirm that `getProviderCredentials()` looks up per-provider CB config from registry and falls back to defaults.

```bash
# The merge itself is implemented in `src/sse/services/auth.js`, in the
# private `getProviderCircuitBreakerConfig`. That module imports through the
# `@/` alias, so Node cannot load it directly — the check below therefore
# verifies the DOCUMENTED precedence against the registry, and the code path
# itself is covered by the integration test in step 4.
node --input-type=module -e "
import registry from './open-sse/providers/registry/index.js';
import { CIRCUIT_BREAKER_CONFIG } from './open-sse/config/runtimeConfig.js';

const d = CIRCUIT_BREAKER_CONFIG.default;
for (const pid of ['openai', 'anthropic', 'groq', 'gemini', 'together', 'unknown-provider']) {
  const entry = registry.find(r => r.id === pid || r.alias === pid);
  const override = entry?.circuitBreaker || {};
  const config = {
    failureThreshold: override.failureThreshold ?? d.failureThreshold,
    coolDownWindowMs: override.coolDownWindowMs ?? d.coolDownWindowMs,
    resetWindowMs: override.resetWindowMs ?? d.resetWindowMs,
  };
  console.log(\`\${pid}: failureThreshold=\${config.failureThreshold}, coolDown=\${config.coolDownWindowMs}ms, reset=\${config.resetWindowMs}ms\`);
}
"
```

**Expected**:
- `openai`: failureThreshold=3 (override), coolDown=120000ms, reset=600000ms
- `anthropic`: failureThreshold=4 (override), coolDown=180000ms, reset=900000ms
- `groq`: failureThreshold=4 (override), coolDown=180000ms, reset=900000ms
- `gemini`: failureThreshold=3 (override), coolDown=120000ms, reset=600000ms
- `together`: failureThreshold=5 (default), coolDown=300000ms, reset=900000ms
- `unknown-provider`: failureThreshold=5 (default), coolDown=300000ms, reset=900000ms (fallback)

### 4. Verify Circuit Breaker Integration in Auth Flow
**Goal**: Test that the circuit breaker opens after enough failures and closes after reset window.

```bash
# `open-sse/services/circuitBreaker.js` is an ES module, and it imports the
# logger and the metrics registry through the `@/` alias — so Node cannot
# load it, with or without `--input-type=module`. The state machine and the
# request path around it are covered by:
npx vitest run tests/unit/circuit-breaker-integration.test.js
npx vitest run tests/unit/circuit-breaker-observability.test.js
```

**Expected**: the circuit opens after `failureThreshold` consecutive failures, refuses while open, admits exactly one probe in half-open, and closes again on a successful response. The observability file covers the state-transition log and the `sse_circuit_breaker_transitions_total` counter.

### 5. Verify the Example Provider Entry
**Goal**: Confirm the shape of a provider's breaker override.

> There is no `CIRCUIT_BREAKER_EXAMPLE_MODEL` constant. An earlier version of
> `open-sse/config/providerModels.js` exported one to show the field shape,
> and it was removed: it was imported by nothing, and its shape was
> per-model — so an operator who followed it set a knob that was silently
> ignored. **A per-model `circuitBreaker` field is never read.** The override
> belongs on the provider's registry entry.

```bash
node --input-type=module -e "
import registry from './open-sse/providers/registry/index.js';
const gemini = registry.find(r => r.id === 'gemini');
console.log('gemini circuitBreaker:', JSON.stringify(gemini.circuitBreaker, null, 2));
"
```

**Expected**: the provider's registry entry carries the breaker override — the same shape the merged configuration in step 3 reads.

### 6. End-to-End Integration Test
**Goal**: Run the existing test suite to ensure no regressions.

```bash
# Run vitest tests related to auth and circuit breaker
npx vitest run --reporter=verbose 2>&1 | head -100
```

**Expected**: Tests should pass. If there are failures, verify that the circuit breaker integration doesn't break existing functionality.

## Summary of Changes

| File | Change |
|------|--------|
| `open-sse/config/runtimeConfig.js` | Added `validateCircuitBreakerConfig()`, `CIRCUIT_BREAKER_SCHEMA` (the schema the validator is derived from), automatic validation |
| `open-sse/providers/registry/{openai,anthropic,groq,gemini,together}.js` | Added `circuitBreaker` field per provider with per-provider overrides |
| `src/sse/services/auth.js` | Updated to look up per-provider CB config from registry, merge with defaults, use in circuit breaker checks |
| `open-sse/config/providerModels.js` | The per-model `CIRCUIT_BREAKER_EXAMPLE_MODEL` constant was **removed**: a per-model override is never read, and the constant advertised one |

## Per-Provider Config Default Merge Logic

When a provider has a `circuitBreaker` field in its registry entry:
- Each field (`failureThreshold`, `coolDownWindowMs`, `resetWindowMs`) that is defined in the provider entry **overrides** the default
- Each field not defined in the provider entry **falls back** to the default value from `CIRCUIT_BREAKER_CONFIG.default`

Example: If openai has `circuitBreaker: { failureThreshold: 3 }` and the default is `failureThreshold: 5`, then the effective config is `failureThreshold: 3`. If openai only had `circuitBreaker: { coolDownWindowMs: 120000 }`, the effective config would be `failureThreshold: 5` (default), `coolDownWindowMs: 120000` (override), `resetWindowMs: 900000` (default).
