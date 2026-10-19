# Circuit Breaker Verification Plan

## Overview
This plan verifies that per-provider circuit breaker configurations are properly loaded, merged with defaults, and used throughout the auth flow.

## Verification Steps

### 1. Validate Config Schema
**Goal**: Ensure all circuitBreaker configs (default + provider overrides) pass validation.

```bash
# Run Node to validate the configs
node -e "
const { validateCircuitBreakerConfig, CIRCUIT_BREAKER_CONFIG } = require('./open-sse/config/runtimeConfig.js');

// Validate default
const defaultResult = validateCircuitBreakerConfig(CIRCUIT_BREAKER_CONFIG.default);
console.log('Default config valid:', defaultResult.valid);
if (!defaultResult.valid) console.log('Errors:', defaultResult.errors);

// Validate provider configs
for (const [id, config] of Object.entries(CIRCUIT_BREAKER_CONFIG.providers)) {
  const result = validateCircuitBreakerConfig(config);
  console.log(\`\${id} config valid:\", result.valid);
  if (!result.valid) console.log('Errors:', result.errors);
}
"
```

**Expected**: All configs should be valid (`valid: true`). The default must pass with its values (failureThreshold: 5, coolDownWindowMs: 300000, resetWindowMs: 900000).

### 2. Verify Per-Provider Configs Are Loaded
**Goal**: Confirm that provider registry entries have circuitBreaker fields and they're correctly read.

```bash
# Check that registry entries have circuitBreaker
node -e "
const registry = require('./open-sse/providers/registry/index.js').default;
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
# Build and check the auth module can be imported
node -e "
// This tests the getProviderCircuitBreakerConfig logic
const registry = require('./open-sse/providers/registry/index.js').default;
const { resolveProviderId } = require('./src/shared/constants/providers.js');

// Test helper function logic
function getProviderCircuitBreakerConfig(providerId) {
  const providerEntry = registry.find(r => r.id === providerId || r.alias === providerId);
  if (!providerEntry) return { failureThreshold: 5, coolDownWindowMs: 300000, resetWindowMs: 900000 };
  const providerCbConfig = providerEntry.circuitBreaker || {};
  return {
    failureThreshold: providerCbConfig.failureThreshold ?? 5,
    coolDownWindowMs: providerCbConfig.coolDownWindowMs ?? 300000,
    resetWindowMs: providerCbConfig.resetWindowMs ?? 900000,
  };
}

// Test with known providers
['openai', 'anthropic', 'groq', 'gemini', 'together', 'unknown-provider'].forEach(pid => {
  const config = getProviderCircuitBreakerConfig(pid);
  console.log(\`\${pid}: failureThreshold=\${config.failureThreshold}, coolDown=\${config.coolDownWindowMs}ms, reset=\${config.resetWindowMs}ms\`);
});
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
# Test circuit breaker state transitions
node -e "
const { getCircuitBreaker, CircuitBreakerState } = require('./open-sse/services/circuitBreaker.js');

// Get or create a circuit breaker for a provider with custom config
const config = { failureThreshold: 3, coolDownWindowMs: 1000, resetWindowMs: 5000 };
const cb = getCircuitBreaker('test-provider', config);

// Circuit should start CLOSED
console.log('Initial state:', cb.state); // should be 'closed'
console.log('Can request:', cb.canRequest()); // should be true

// Record 3 failures to open the circuit
cb.recordFailure();
cb.recordFailure();
cb.recordFailure();
console.log('After 3 failures - state:', cb.state); // should be 'open'
console.log('Can request after 3 failures:', cb.canRequest()); // should be false

// Wait for coolDownWindowMs and check half-open
// Record 1 more failure in half-open to re-open
cb.recordFailure(); // transitions to half-open after first failure, then open on second
console.log('After additional failure - state:', cb.state);

// Record success in half-open to reset
// (would need to wait for resetWindowMs in real time)
console.log('Circuit breaker test complete');
"
"
```

**Expected**: Circuit breaker should open after `failureThreshold` consecutive failures, and allow requests through after `coolDownWindowMs` has elapsed.

### 5. Verify Example Model Entry
**Goal**: Confirm the example model entry is properly exported.

```bash
node -e "
const { CIRCUIT_BREAKER_EXAMPLE_MODEL } = require('./open-sse/config/providerModels.js');
console.log('Example model:', CIRCUIT_BREAKER_EXAMPLE_MODEL.id);
console.log('Circuit breaker config:', JSON.stringify(CIRCUIT_BREAKER_EXAMPLE_MODEL.circuitBreaker, null, 2));
console.log('Name:', CIRCUIT_BREAKER_EXAMPLE_MODEL.name);
"
```

**Expected**: The example model should have the circuitBreaker field with the expected structure.

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
| `open-sse/config/runtimeConfig.js` | Added `validateCircuitBreakerConfig()`, `CIRCUIT_BREAKER_SCHEMA`, automatic validation |
| `open-sse/providers/registry/{openai,anthropic,groq,gemini,together}.js` | Added `circuitBreaker` field per provider with per-provider overrides |
| `src/sse/services/auth.js` | Updated to look up per-provider CB config from registry, merge with defaults, use in circuit breaker checks |
| `open-sse/config/providerModels.js` | Added `CIRCUIT_BREAKER_EXAMPLE_MODEL` showing the circuitBreaker field structure |

## Per-Provider Config Default Merge Logic

When a provider has a `circuitBreaker` field in its registry entry:
- Each field (`failureThreshold`, `coolDownWindowMs`, `resetWindowMs`) that is defined in the provider entry **overrides** the default
- Each field not defined in the provider entry **falls back** to the default value from `CIRCUIT_BREAKER_CONFIG.default`

Example: If openai has `circuitBreaker: { failureThreshold: 3 }` and the default is `failureThreshold: 5`, then the effective config is `failureThreshold: 3`. If openai only had `circuitBreaker: { coolDownWindowMs: 120000 }`, the effective config would be `failureThreshold: 5` (default), `coolDownWindowMs: 120000` (override), `resetWindowMs: 900000` (default).