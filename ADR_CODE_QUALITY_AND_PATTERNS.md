# ADR: Code Quality Standards and Implementation Patterns for 9router

**Date**: 2026-10-19
**Author**: Senior Developer Subagent
**Status**: Proposed

## 1. Code Quality Assessment

### 1.1 TypeScript Usage
- **Current State**: The project uses `jsconfig.json` with path aliases (`@/*` → `src/*`, `open-sse` → `open-sse/`), but there is NO formal TypeScript setup. All source files are `.js` files with JSDoc type annotations.
- **Issues**:
  - No type checking in CI/CD
  - IDE support limited compared to full TS
  - No type safety for provider configs, executor patterns, or translator schemas
- **Recommendation**: Migrate to TypeScript gradually, starting with the open-sse core files (providers, executors, translators) where type safety has the highest impact.

### 1.2 Pattern Consistency
- **CamelCase**: Consistent across exports, functions, and variables ✓
- **DRY (Don't Repeat Yourself)**: 
  - ✓ Provider registry is single source of truth (`open-sse/providers/registry/`)
  - ✓ `TTS_MODELS_CONFIG` centralized in `open-sse/config/ttsModels.js`
  - ✓ `PROVIDER_DEFAULTS` in `open-sse/providers/schema.js`
  - ✓ Translator concerns shared via `translator/concerns/`
- **Config-driven**: 
  - ✓ Provider transport config from registry entries
  - ✓ Model capabilities from `config/providerModels.js` + `capabilities.js`
  - ✗ **ISSUE**: `SPECIAL_ADAPTERS` hardcoded in `open-sse/handlers/ttsProviders/index.js` (9 providers as string keys)
  - ✗ **ISSUE**: `handleTtsCore` has hardcoded adapter dispatch logic (lines 57-64)

### 1.3 Hardcode Values Identification
| Location | Issue | Severity |
|----------|-------|----------|
| `open-sse/handlers/ttsProviders/index.js:15-25` | `SPECIAL_ADAPTERS` has 9 providers hardcoded | HIGH |
| `open-sse/handlers/ttsCore.js:57-64` | Adapter dispatch hardcoded in `handleTtsCore` | MEDIUM |
| `open-sse/handlers/ttsProviders/index.js:33` | Dynamic `import()` inside `synthesizeViaConfig()` | MEDIUM |
| `src/app/layout.js:45` | ~~Hardcoded `setTimeout(f, 1000)` for font loading~~ | **RESOLVED** — reduced to `setTimeout(f, 500)` |
| `src/app/layout.js:28` | ~~`fontPreconnect` defined but `<link rel="preconnect">` not added to HTML head~~ | **RESOLVED** — removed; `next/font`'s `Inter()` emits the preconnect itself |

### 1.4 Error Handling Consistency
- **Consistent Patterns**:
  - `createErrorResult()` used across TTS handlers with `HTTP_STATUS` enum
  - All executor `execute()` methods stream responses
  - Translators are "fail-open" - errors return `null` and leave body untouched (rtk/headroom.js, rtk/caveman.js)
  - `rtk/` + `headroom.js` mutate request body in-place and never throw
- **Gaps**:
  - Some test files swallow errors silently
  - No consistent error boundary at the API route level
  - Missing error logging in some translator paths

### 1.5 Import Organization
- **Source Files** (`src/`): Use `@/` aliases resolved via `jsconfig.json`/`next.config.mjs`. Well-organized.
- **open-sse Files**: Use `open-sse/` aliases. Consistent.
- **Test Files** (`tests/unit/`): Use `@/` aliases in `vitest.config.js`, but resolution is unreliable (see ADR-002).
- **Dynamic Imports**: `synthesizeViaConfig()` uses `import("@/shared/constants/providers")` inside function body - inconsistent with top-level imports elsewhere.

---

## 2. Implementation Patterns

### 2.1 Provider Registration Pattern
**Flow**: Registry entry (`providers/registry/{id}.js`) → `providers/index.js` builds `PROVIDERS`/`PROVIDER_MODELS` → consumed by `services/model.js` → `parseModel()` resolves provider/alias → used throughout the pipeline.

**Template** (`REGISTRY_TEMPLATE.js`):
```javascript
// Minimal provider entry
export default {
  id: "provider-id",       // REQUIRED
  category: "apikey",      // REQUIRED
  transport: {
    baseUrl: "https://api.provider.com",
    format: "openai",
    // ... other transport config
  },
  models: ["model-1", "model-2"],  // optional
  oauth: { /* oauth config */ },    // optional
  media: { /* ttsConfig, sttConfig */ }  // optional
};
```

**How to Add a Provider**:
1. Copy `REGISTRY_TEMPLATE.js` → `providers/registry/{id}.js`
2. Fill in `id`, `category`, `transport`, optionally `models`, `oauth`, `media`
3. Run `npm run fix:regenerate` or manually regenerate `providers/index.js`

### 2.2 Executor Subclass Pattern
**Base Class**: `BaseExecutor` (`open-sse/executors/base.js`) provides:
- `getBaseUrls(provider)` - returns provider API base URLs
- `buildHeaders(transport)` - builds request headers including auth
- `buildUrl(path, transport)` - constructs full API URL
- `execute(request)` - main method, streams upstream response

**Specialized Executors** override methods for non-standard APIs:
- `AzureExecutor` - handles Azure OpenAI's different endpoint format
- `BedrockExecutor` - handles AWS Bedrock's token authentication
- `GeminiCLIExecutor` - handles Gemini CLI's stdin-based interface
- `DefaultExecutor` - handles OpenAI-compatible APIs (fallback)

**Registry**: `executors/index.js` maps provider names to executor instances:
```javascript
const executors = {
  azure: new AzureExecutor(),
  bedrock: new BedrockExecutor(),
  // ... all special providers
  // DefaultExecutor is auto-created for unknown providers
};
```

**How to Add an Executor**:
1. Subclass `BaseExecutor` in `open-sse/executors/{id}.js`
2. Override methods as needed (`getBaseUrls`, `buildHeaders`, `buildUrl`, `execute`)
3. Import and register in `open-sse/executors/index.js`
4. Add registry entry with appropriate `transport.executor` field

### 2.3 Translator Registration via Side-Effects
**Pattern**: Translator modules self-register via `register(from, to, reqFn, resFn)` called as a static import side-effect.

**Index.js Bottom** (lines 307-329):
```javascript
// Static side-effect imports: each module calls register() at load (works in ESM + bundler).
import "./request/claude-to-openai.js";
import "./request/openai-to-claude.js";
// ... more imports
```

**How to Add a Translator**:
1. Create `translator/request/{from}-to-{to}.js` or `translator/response/{from}-to-{to}.js`
2. At the top of the file, call `register(from, to, requestFn, responseFn)`
3. Import the file in `translator/index.js` at the bottom

**Example** (`translator/request/claude-to-openai.js`):
```javascript
import { register } from "../index.js";
import { filterToOpenAIFormat } from "./openai.js";

// ... parse Claude format → OpenAI format

register("claude", "openai", (model, body, stream, credentials) => {
  // request transformation logic
});
```

### 2.4 Config-driven vs Hardcoded Values
**Config-driven (preferred)**:
- Provider definitions in `open-sse/providers/registry/{id}.js`
- Model lists in `open-sse/config/providerModels.js`
- TTS configs in `open-sse/config/ttsModels.js`
- Capability mappings in `open-sse/providers/capabilities.js`
- Runtime config in `open-sse/config/runtimeConfig.js`

**Hardcoded (violations)**:
- `SPECIAL_ADAPTERS` in `open-sse/handlers/ttsProviders/index.js` - 9 providers hardcoded
- `handleTtsCore` adapter dispatch logic - provider list hardcoded
- `synthesizeViaConfig()` dynamic import inside function body
- ~~Font preconnect constant defined but not used in HTML head~~ — RESOLVED (removed; `next/font` emits the preconnect itself)
- ~~Font loading timeout hardcoded at 1000ms~~ — RESOLVED (reduced to 500ms)

---

## 3. ADR: Recommended Code Quality Standards

### 3.1 Enforcement Mechanisms
1. **ESLint Config**: Extend `eslint-config-next` with custom rules:
   - `@typescript-eslint/ban-types` for type safety
   - Custom rule: `no-hardcoded-strings` flagging provider strings not from registry
   - Custom rule: `config-driven-require` requiring config references over literals

2. **Husky Pre-commit Hooks**: Run `npm run lint` and `npm run type-check` before commits

3. **CI/CD GitHub Actions**: 
   - `npm run lint` 
   - `npm run test:unit` (vitest)
   - `npm run typecheck` (if TS added)
   - Drift prevention checklist (ADR-004)

4. **Pattern Validation Scripts**: 
   - Import alias resolution test
   - Config-driven validation (no hardcoded provider strings)
   - Executor registry completeness check

### 3.2 Pattern Consistency Recommendations
1. **Always use registry entries** instead of hardcoded provider strings
2. **Never mix config-driven and hardcoded patterns** for the same concern
3. **Translator modules MUST be imported** in `translator/index.js` - add lint rule
4. **Executors must be registered** in `executors/index.js` - add registry completeness check
5. **All dynamic imports** should be at module level, not inside functions

### 3.3 Refactoring Priorities (High to Low)
1. **FIX**: Move `SPECIAL_ADAPTERS` to provider registry entries with `ttsAdapter` field (ADR-001)
2. **FIX**: Update test imports from `@/` to relative paths (ADR-002) 
3. **FIX**: Add `<link rel="preconnect">` to layout head (ADR-003)
4. ~~**FIX**: Reduce font loading timeout from 1s to 500ms (ADR-003)~~ — **DONE**
5. **FIX**: Move adapter registry to provider registry entries (ADR-001 follow-up)
6. **FIX**: Move `synthesizeViaConfig` import to module level (ADR-001 follow-up)
7. **FIX**: Refactor `handleTtsCore` to be more config-driven (ADR-001 follow-up)

### 3.4 Migration Path from Current State to Ideal State

**Phase 1: Quick Wins (1-2 days)**
- ~~Add `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` to `src/app/layout.js`~~ — **DONE** (not needed: `next/font`'s `Inter()` emits it)
- ~~Reduce font loading timeout from 1000ms to 500ms~~ — **DONE**
- Update vitest config alias to use absolute path: `{find: /^@\\//, replacement: resolve(__dirname, "../../src") + "/"}`

**Phase 2: Medium-term (1-2 weeks)**
- Move `SPECIAL_ADAPTERS` to provider registry entries (each provider gets `ttsAdapter` field)
- Update `handleTtsCore` to check provider registry for adapter instead of hardcoded map
- Move `synthesizeViaConfig` import to module level
- Fix vitest alias resolution (Option 1: update test imports to relative paths, OR Option 2: fix vitest config)

**Phase 3: Long-term (1 month)**
- Full TypeScript migration for open-sse core files
- Implement drift prevention CI checklist (ADR-004)
- Create automated pattern-matching regression tests
- Build provider registry schema validation tool

### 3.5 Technical Debt Remediation Roadmap

| Debt Item | Status | Discoverd | Effort | Impact | Risk |
|-----------|--------|-----------|--------|--------|------|
| vitest alias resolution - 5 test files need import path updates | pending | 2026-10-19 | 1 hour | HIGH | low |
| Font preconnect defined but not used in layout | resolved | 2026-10-19 | 5 min | HIGH | very-low |
| FONT LOADING TIMEOUT at 1s | resolved | 2026-10-19 | 5 min | MEDIUM | very-low |
| SPECIAL_ADAPTERS hardcoded in ttsProviders/index.js | pending | 2026-10-19 | 2-3 hours | HIGH | medium |
| synthesizeViaConfig dynamic import() inside function body | pending | 2026-10-19 | 1 hour | MEDIUM | low |
| handleTtsCore adapter logic not fully config-driven | pending | 2026-10-19 | 1-2 hours | MEDIUM | low |

**Roadmap**:
1. **Week 1**: Quick wins (font preconnect, timeout, vitest aliases)
2. **Week 2**: Config-driven TTS adapter pattern (move SPECIAL_ADAPTERS to registry)
3. **Week 3**: TypeScript migration start + pattern validation scripts
4. **Week 4**: Drift prevention CI enforcement + comprehensive testing

---

## 4. Recommendations

### 4.1 Code Review Checklist
- [ ] No hardcoded provider strings (use registry entry or config value)
- [ ] All translator modules imported in `translator/index.js`
- [ ] All executors registered in `executors/index.js`
- [ ] Config-driven values sourced from `config/`, `schema/`, or `registry/`
- [ ] Import aliases resolve correctly (vitest or runtime)
- [ ] Error handling uses `createErrorResult()` pattern
- [ ] 60fps animations verified (no layout thrashing)
- [ ] Responsive design tested at mobile breakpoints
- [ ] Dark mode compatible (uses CSS variables, not hardcoded colors)
- [ ] No console.error in production code paths

### 4.2 Automated Linting/Format Checks
```
npm run lint          # ESLint with custom rules
npm run test:unit    # vitest unit tests
npm run test:drift   # Custom: import alias resolution check
npm run test:patterns # Custom: config-driven validation, no hardcoded strings
```

**Custom Lint Rules to Add**:
- `no-hardcoded-provider-strings`: Flags any string matching provider ID pattern not from registry
- `require-translator-registration`: Ensures new translator files are imported in index.js
- `require-executor-registration`: Ensures new executors are registered in index.js
- `no-dynamic-imports-inside-functions`: Flags `import()` inside function bodies

### 4.3 Pattern Validation Scripts
```bash
# Check import alias resolution
node -e "
const { resolve } = require('path');
const __dirname = './tests';
const vitestAlias = resolve(__dirname, '../src') + '/';
console.log('Alias resolution test would go here');
"

// Check executor registry completeness
node -e "
const executors = require('./open-sse/executors/index.js');
const registry = require('./open-sse/providers/registry/index.js').default;
const providerIds = Object.keys(registry).map(r => r.id);
const registeredExporters = Object.keys(executors.PROVIDERS || {});
console.log('Missing executors:', providerIds.filter(id => !registeredExporters.includes(id)));
"
```

### 4.4 Onboarding New Developer Setup
1. **Clone repo** and run `npm install`
2. **Run type check**: `npx tsc --noEmit` (if TS added) or `eslint .` 
3. **Run unit tests**: `npx vitest run` (may need API keys for provider tests)
4. **Check drift prevention**: Run `npm run test:drift` to verify import aliases
5. **Review conventions**: Read `open-sse/AGENTS.md` and `ARCHITECTURE_AUDIT.json`
6. **First PR**: Must pass all 4 drift prevention checklist items
7. **Mentor**: Pair with senior developer on first config-driven pattern implementation

### 4.5 Key Files to Reference
- `open-sse/AGENTS.md` - Convention reference
- `ARCHITECTURE_AUDIT.json` - Architecture overview and issues
- `SRE_ADR.md` - Site reliability engineering decisions
- `FIX_PLAN.md` - Planned fixes and priorities
- `FINAL_SUMMARY.md` - Overall project summary
- `web-performance-analysis.md` - Performance analysis and recommendations

---
*This ADR should be reviewed and updated whenever convention violations are identified or when the codebase undergoes significant refactoring.*