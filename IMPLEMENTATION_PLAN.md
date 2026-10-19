# Implementation Plan: Code Quality Improvements for 9router

**Date**: 2026-10-19
**Phase**: Planning & Review
**Status**: Proposed

## Implementation Planning Overview

This plan covers the refactoring of identified code quality issues with proper review, critique, and implementation steps. All changes are grounded in evidence from the actual codebase analysis.

---

## 📋 Review of Current State vs Ideal State

### Current State Assessment

| Area | Current | Ideal | Gap |
|------|---------|-------|-----|
| **TTS Adapters** | `SPECIAL_ADAPTERS` hardcoded in `ttsProviders/index.js` (9 providers) | Provider registry entries with `ttsAdapter` field | Requires code changes for new providers |
| **Import Aliases** | `@/` works in source, fails in 5 test files | All imports resolve consistently | 5 test files need path updates |
| **Font Preconnect** | ~~`fontPreconnect` constant defined but `<link>` not in HTML head~~ | **RESOLVED** — `next/font`'s `Inter()` emits the preconnect itself; the dead constant and the invalid inline `<script>` were removed | No manual `<link>` needed |
| **Font Timeout** | ~~`setTimeout(f, 1000)` (1s)~~ | **RESOLVED** — `setTimeout(f, 500)` (500ms) | 500ms earlier font visibility |
| **synthesizeViaConfig** | Dynamic `import()` inside function body | Module-level import at top | Inconsistent pattern |
| **handleTtsCore** | Hardcoded adapter dispatch logic | Registry-based adapter lookup | Violates config-driven convention |

---

## 🛠️ Implementation Tasks

### Task 1: Fix vitest Import Alias Resolution (HIGH Priority, 1 hour)

**Files to modify**: 5 test files

**Test files needing import path updates** (from ADR-002 and code assessment):

1. `tests/unit/bedrock-provider-api-secrets.test.js`
   - `@/app/api/providers/route.js` → `../../../src/app/api/providers/route.js`
   - `@/app/api/providers/[id]/route.js` → `../../../src/app/api/providers/[id]/route.js`
   - `@/models/index.js` → `../../../src/models/index.js`

2. `tests/unit/force-stream-config.test.js`
   - `@/lib/dataDir.js` → `../../../src/lib/dataDir.js`

3. `tests/unit/db-migration-chain.test.js`
   - `@/lib/db/driver.js` → `../../../src/lib/db/driver.js`

**Implementation**:
```bash
# Navigate to tests directory and update imports
cd C:\9router\tests\unit

# Example sed commands for each file:
sed -i 's|from ["']@/app/api/providers/route.js["']|from "../../../src/app/api/providers/route.js"|g' bedrock-provider-api-secrets.test.js
sed -i 's|from ["']@/app/api/providers/\[id\]/route.js["']|from "../../../src/app/api/providers/[id]/route.js"|g' bedrock-provider-api-secrets.test.js
sed -i 's|from ["']@/models/index.js["']|from "../../../src/models/index.js"|g' bedrock-provider-api-secrets.test.js
sed -i 's|from ["']@/lib/dataDir.js["']|from "../../../src/lib/dataDir.js"|g' force-stream-config.test.js
sed -i 's|from ["']@/lib/db/driver.js["']|from "../../../src/lib/db/driver.js"|g' db-migration-chain.test.js
```

**Review Critique**:
- **Pros**: Most reliable fix; works regardless of vitest config; one-time effort
- **Cons**: Longer import paths; more fragile to directory moves (mitigated by keeping tests in stable location)
- **Decision**: Proceed with Option 1 (relative paths) as recommended in ADR-002

---

### Task 2: Add Font Preconnect to Layout (HIGH Impact/Low Effort, 5 minutes)

**File to modify**: `src/app/layout.js`

**Change**: Add `<link rel="preconnect">` tag in the `<head>` alongside the Google Analytics script.

**Current code** (layout.js lines 52-59):
```html
      <GoogleAnalytics gaId={"G-LC959F603F"} />
```

**New code**:
```html
      <GoogleAnalytics gaId={"G-LC959F603F"} />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
```

**Review Critique**:
- **Pros**: High impact/low effort; improves LCP; no user-visible behavior change; aligns with web-performance-analysis.md Phase 5
- **Cons**: Limited benefit for returning visitors (fonts already cached); minimal code change
- **Decision**: Proceed - minimal risk, measurable gain

---

### Task 3: Reduce Font Loading Timeout (MEDIUM Priority, 5 minutes)

**Status**: DONE — `src/app/layout.js` uses `setTimeout(f, 500)`.

**File to modify**: `src/app/layout.js`

**Change**: Reduce `setTimeout` from 1000ms to 500ms.

**Current code** (layout.js line 49):
```javascript
setTimeout(f, 1000) // 1s timeout
```

**New code**:
```javascript
setTimeout(f, 500) // 500ms timeout
```

**Review Critique**:
- **Pros**: Earlier font visibility; improves FCP; 50% reduction in wait time; no behavior change for cached fonts
- **Cons**: 500ms may still be too long for slow connections; could be made configurable
- **Decision**: Proceed - simple win; consider making configurable in future

---

### Task 4: Move SPECIAL_ADAPTERS to Provider Registry (HIGH Priority, 2-3 hours)

**Files to modify**:
1. `open-sse/providers/registry/*.js` - Add `ttsAdapter` field to relevant entries
2. `open-sse/handlers/ttsProviders/index.js` - Update `getTtsAdapter()`
3. `open-sse/handlers/ttsCore.js` - Update `handleTtsCore()`

**Step 4.1**: Add `ttsAdapter` field to provider registry entries

**Providers that need `ttsAdapter`** (based on SPECIAL_ADAPTERS map):
- `google-tts` → `googleTts`
- `edge-tts` → `edgeTts`  
- `local-device` → `localDevice`
- `elevenlabs` → `elevenlabs`
- `openai` → `openai`
- `openrouter` → `openrouter`
- `gemini` → `gemini`
- `xiaomi-mimo` → `xiaomiMimo`
- `selfhosted-tts` → `selfhostedTts`

**Example registry entry update** (`open-sse/providers/registry/google-tts.js`):
```javascript
// Before:
export default {
  id: "google-tts",
  category: "apikey",
  transport: { /* ... */ },
  models: [],
};

// After:
export default {
  id: "google-tts",
  category: "apikey",
  transport: { /* ... */ },
  ttsAdapter: "googleTts",  // NEW: references the adapter module
  models: [],
};
```

Repeat for all 9 providers in the registry.

**Step 4.2**: Update `getTtsAdapter()` in `ttsProviders/index.js`

**Before**:
```javascript
const SPECIAL_ADAPTERS = {
  "google-tts": googleTts,
  "edge-tts": edgeTts,
  "local-device": localDevice,
  elevenlabs,
  openai,
  openrouter,
  gemini,
  "xiaomi-mimo": xiaomiMimo,
  "selfhosted-tts": selfhostedTts,
};

export function getTtsAdapter(provider) {
  return SPECIAL_ADAPTERS[provider] || null;
}
```

**After**:
```javascript
export function getTtsAdapter(provider) {
  // Look up provider in registry for ttsAdapter field
  const entry = REGISTRY.find(
    r => r.id === provider || r.alias === provider
  );
  
  if (!entry?.ttsAdapter) return null;
  
  // Dynamically import the adapter module
  // Note: This still uses dynamic import but at point of use, not inside synthesizeViaConfig
  let adapterModule;
  try {
    adapterModule = await import(`../ttsProviders/${entry.ttsAdapter}.js`);
  } catch (e) {
    console.warn(`TTS adapter ${entry.ttsAdapter} not found for provider ${provider}`);
    return null;
  }
  
  return adapterModule.default || adapterModule;
}
```

**Step 4.3**: Update `handleTtsCore()` in `ttsCore.js`

**Before** (has hardcoded adapter check):
```javascript
export async function handleTtsCore({ provider, model, input, credentials, responseFormat = "mp3", language, style }) {
  // ...
  // Special-case adapters (google-tts, edge-tts, local-device, elevenlabs, openai, openrouter, gemini, xiaomi-mimo)
  const adapter = getTtsAdapter(provider);
  if (adapter) {
    const result = await adapter.synthesize(input.trim(), model, credentials, responseFormat, { language, style });
    // ...
  }

  // Generic config-driven (hyperbolic, deepgram, nvidia, ...)
  const result = await synthesizeViaConfig(provider, input.trim(), model, credentials);
  // ...
}
```

**After** (simplified - all providers go through same path):
```javascript
export async function handleTtsCore({ provider, model, input, credentials, responseFormat = "mp3", language, style }) {
  if (!input?.trim()) {
    return createErrorResult(HTTP_STATUS.BAD_REQUEST, "Missing required field: input");
  }

  try {
    // Check if provider has a TTS adapter in registry
    const adapter = getTtsAdapter(provider);
    if (adapter) {
      const result = await adapter.synthesize(input.trim(), model, credentials, responseFormat, { language, style });
      // Adapter may return a full {success, response} (legacy) or {base64, format}
      if (result.success !== undefined) return result;
      return createTtsResponse(result.base64, result.format, responseFormat);
    }

    // Generic config-driven path (hyperbolic, deepgram, nvidia, huggingface, inworld, cartesia, playht, coqui, tortoise, qwen, ...)
    const result = await synthesizeViaConfig(provider, input.trim(), model, credentials);
    if (result) return createTtsResponse(result.base64, result.format, responseFormat);

    return createErrorResult(HTTP_STATUS.BAD_REQUEST, `Provider '${provider}' does not support TTS via this route.`);
  } catch (err) {
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, err.message || "TTS synthesis failed");
  }
}
```

**Review Critique**:
- **Pros**: New providers can be added by updating registry entry only; no code changes to `ttsProviders/index.js` or `ttsCore.js`; preserves performance of direct adapter calls; extends config-driven convention
- **Cons**: Initial setup requires updating 9 registry entries; dynamic import still used (but at point of use, not inside synthesizeViaConfig); slight complexity in `getTtsAdapter()`
- **Decision**: Proceed - long-term benefit outweighs initial setup cost; hybrid approach preserves performance while enabling extensibility

---

### Task 5: Move synthesizeViaConfig Import to Module Level (MEDIUM Priority, 1 hour)

**File to modify**: `open-sse/handlers/ttsProviders/index.js`

**Before** (dynamic import inside function):
```javascript
export async function synthesizeViaConfig(provider, text, model, credentials) {
  const { AI_PROVIDERS } = await import("@/shared/constants/providers");
  const cfg = AI_PROVIDERS[provider]?.ttsConfig;
  // ...
}
```

**After** (module-level import at top of file):
Add to top of `ttsProviders/index.js`:
```javascript
import { AI_PROVIDERS } from "@/shared/constants/providers";
```

And remove the dynamic import from inside `synthesizeViaConfig()`:
```javascript
export async function synthesizeViaConfig(provider, text, model, credentials) {
  const cfg = AI_PROVIDERS[provider]?.ttsConfig;
  // ... rest unchanged, no await needed for import
}
```

**Review Critique**:
- **Pros**: Consistent with pattern used elsewhere; removes unnecessary async boundary; simpler code; easier to reason about module caching
- **Cons**: Must ensure no circular dependency issues with `@/shared/constants/providers`; need to verify the import resolves correctly in all contexts (Node vs browser)
- **Decision**: Proceed - clear win; verify with test runs

---

### Task 6: Refactor handleTtsCore to Be More Config-Driven (MEDIUM Priority, 1-2 hours)

**Related to**: Task 4 (SPECIAL_ADAPTERS move to registry)

**Additional refinements** after moving adapters to registry:

1. **Remove duplicate logic**: After `getTtsAdapter()` reads from registry, `handleTtsCore` no longer needs its own adapter dispatch logic
2. **Fallback consistency**: Ensure all providers not in registry fall through to `synthesizeViaConfig()`
3. **Error handling**: Maintain consistent error patterns across both paths

**Implementation detail**: After completing Task 4, `handleTtsCore` should look like the "After" version in Task 4's review. No additional changes needed beyond what Task 4 already covers.

---

## 📊 Implementation Timeline

| Phase | Duration | Tasks | Deliverables |
|-------|----------|-------|-------------|
| **Phase 1: Quick Wins** | 1-2 days | Task 1 (vitest aliases), Task 2 (font preconnect), Task 3 (font timeout) | All 3 fixes deployed; vitest tests pass; performance improvements measured |
| **Phase 2: Medium-term** | 1-2 weeks | Task 4 (SPECIAL_ADAPTERS to registry), Task 5 (synthesizeViaConfig import), Task 6 (handleTtsCore refactor) | Config-driven TTS pattern implemented; no hardcoded adapter lists; import consistency fixed |
| **Phase 3: Long-term** | 1 month | Task 7 (TypeScript migration), Task 8 (drift prevention CI), Task 9 (registry schema validation) | Full type safety; CI checks enforcing conventions; automated validation tools |

---

## ✅ Success Criteria Checklist

### Immediate (after Phase 1)
- [ ] vitest runs from any directory without alias resolution failures
- [ ] `<link rel="preconnect">` present in layout head HTML
- [ ] Font timeout reduced to 500ms
- [ ] LCP improved (measure with Lighthouse)

### Medium-term (after Phase 2)
- [ ] `SPECIAL_ADAPTERS` removed from `ttsProviders/index.js` (or reduced to minimal set)
- [ ] New TTS providers can be added by updating registry entries only
- [ ] `synthesizeViaConfig` uses module-level import (no dynamic import inside function)
- [ ] `handleTtsCore` has no hardcoded provider lists
- [ ] All 9 current TTS providers work through either adapter or config-driven path

### Long-term (after Phase 3)
- [ ] TypeScript types for provider registry, executors, translators
- [ ] Drift prevention CI checklist passing on every PR
- [ ] Pattern validation scripts running in CI
- [ ] New developer onboarding: `npm run fix:drift` validates conventions

---

## ⚠️ Risk Assessment

| Task | Risk Level | Mitigation |
|------|------------|------------|
| Task 1 (vitest aliases) | LOW | Well-tested relative paths; fallback to Option 2 (fix vitest config) if needed |
| Task 2 (font preconnect) | VERY LOW | 5 lines of HTML; no runtime risk |
| Task 3 (font timeout) | VERY LOW | 1 line change; reversible if issues arise |
| Task 4 (SPECIAL_ADAPTERS → registry) | MEDIUM | Keep backward compatibility; both paths work; registry entries are the single source of truth |
| Task 5 (synthesizeViaConfig import) | LOW | Module-level import; verify with `node --check`; test in both Node and browser contexts |
| Task 6 (handleTtsCore refactor) | MEDIUM | Maintain both adapter and config-driven paths during transition; comprehensive testing |

---

## 📝 Final Notes

All implementation steps are:
1. **Grounded in evidence** - based on actual code analysis of 138+ provider registries, 30+ executors, 30+ translators
2. **Consistent with conventions** - respecting open-sse/AGENTS.md: "Config-driven, DRY, camelCase. NEVER hardcode values"
3. **Incremental** - each task is independently verifiable and rollback-safe
4. **CI-ready** - changes designed to pass or improve automated checks

The plan follows the refactoring priorities from ADR-001 through ADR-004, ensuring systematic remediation of technical debt rather than ad-hoc fixes.

---
*Implementation plan grounded in evidence from: ARCHITECTURE_AUDIT.json, open-sse/AGENTS.md, ttsProviders/index.js, ttsCore.js, providers/index.js, executors/index.js, translator/index.js, and all configuration files in the repository.*