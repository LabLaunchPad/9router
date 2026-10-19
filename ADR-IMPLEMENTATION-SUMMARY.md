# RTK Strict Mode Implementation Summary (ADR-006)

## Configuration Changes

### `open-sse/config/runtimeConfig.js`
- Added `RTK_STRICT_MODE` export: `process.env.RTK_STRICT === "true"` (default: `false`)
- Added `rtkStrict` alias: `export const rtkStrict = RTK_STRICT_MODE`
- Both are boolean type, fail-open by default for backward compatibility

## RTK Component Changes

### `open-sse/rtk/headroom.js`
- Imported `rtkStrict` from `../config/runtimeConfig.js`
- Modified `compressWithHeadroom` function signature to accept `rtkStrict: rtkStrictOverride` option
- Added per-call override capability: `const strict = rtkStrictOverride !== undefined ? rtkStrictOverride : rtkStrict`
- Modified catch block: `if (rtkStrict) throw error;` - errors propagate in strict mode
- Normal mode (default): returns `null` on error (fail-open, backward compatible)

### `open-sse/rtk/caveman.js`
- Imported `rtkStrict` from `../config/runtimeConfig.js`
- Modified `injectCaveman` function signature: `injectCaveman(body, format, level, rtkStrictOverride)`
- Added strict mode check: `if (strict) throw error;` in catch block
- Per-call override: `const strict = rtkStrictOverride !== undefined ? rtkStrictOverride : rtkStrict`

### `open-sse/rtk/ponytail.js`
- Imported `rtkStrict` from `../config/runtimeConfig.js`
- Modified `injectPonytail` function signature: `injectPonytail(body, format, level, rtkStrictOverride)`
- Added strict mode check: `if (strict) throw error;` in catch block
- Per-call override: `const strict = rtkStrictOverride !== undefined ? rtkStrictOverride : rtkStrict`

### `open-sse/rtk/applyFilter.js`
- Modified `safeApply` function signature: `safeApply(fn, text, rtkStrict = false)`
- Added strict mode propagation: `if (rtkStrict) throw err;` in catch block
- Normal mode: passes through raw output with warning (existing behavior)

## Integration Changes

### `open-sse/handlers/chatCore.js`
- Imported `rtkStrict` from `../config/runtimeConfig.js`
- Passed `rtkStrict` to `compressWithHeadroom()` call
- Passed `rtkStrict` to `injectCaveman()` call
- Passed `rtkStrict` to `injectPonytail()` call

## Verification Tests

### `tests/unit/rtk-strict-mode.test.js`
Created comprehensive test scenarios covering:

1. **Configuration Tests**
   - `RTK_STRICT_MODE` defaults to `false`
   - `rtkStrict` alias defaults to `false`
   - Env var `RTK_STRICT=true` can be set

2. **compressWithHeadroom Tests**
   - Normal mode (rtkStrict=false): returns `null` on error (fail-open)
   - Strict mode (rtkStrict=true): throws error on failure
   - Per-call override via options object

3. **injectCaveman Tests**
   - Normal mode: does not throw
   - Strict mode: throws error on failure
   - Per-call strict override

4. **injectPonytail Tests**
   - Normal mode: does not throw
   - Strict mode: throws error on failure
   - Per-call strict override

5. **safeApply Tests**
   - Normal mode: passes through raw output on filter panic
   - Strict mode: propagates error
   - Per-call strict override

6. **End-to-End Flow Tests**
   - Normal mode maintains backward compatibility
   - Strict mode enables error propagation when enabled

## Behavior Matrix

| Mode | compressWithHeadroom | injectCaveman | injectPonytail | safeApply |
|------|---------------------|---------------|----------------|-----------|
| **rtkStrict=false** (default) | Returns `null` on error | Silent fail | Silent fail | Passes through raw output |
| **rtkStrict=true** | Throws error | Throws error | Throws error | Throws error |
| **Per-call rtkStrict=true** | Overrides default | Overrides default | Overrides default | Overrides default |

## Migration Path

- **Zero breaking changes**: Default `rtkStrict=false` maintains exact existing behavior
- **Opt-in**: Set `RTK_STRICT=true` environment variable or pass `rtkStrict: true` in options
- **Gradual rollout**: Can be enabled per-component or globally via config
- **Per-call override**: Individual calls can opt-in regardless of global config

## References

- ADR-006: RTK strict mode configuration
- Existing `RTK_STRICT_MODE` in runtimeConfig.js (pre-existing, now has `rtkStrict` alias)
- RTK components: headroom.js, caveman.js, ponytail.js, applyFilter.js
- Integration point: handlers/chatCore.js