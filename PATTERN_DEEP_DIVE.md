# Pattern Deep Dive: 9router Codebase Analysis

**Date**: 2026-10-19
**Focus**: Provider registration, executor subclass, translator registration, config-driven patterns

## 1. Provider Registration Pattern

### 1.1 Current Implementation

**File**: `open-sse/providers/index.js`
**Purpose**: Single entry point that builds `PROVIDERS`, `PROVIDER_MODELS`, `PROVIDER_OAUTH`, `PROVIDER_MEDIA` from registry entries.

```javascript
// Key lines from open-sse/providers/index.js
import REGISTRY from "./registry/index.js";
import { PROVIDER_DEFAULTS } from "./schema.js";
import { normalizeModel } from "./models/schema.js";
import { buildTtsProviderModels } from "../config/ttsModels.js";

export const PROVIDERS = {};
export const PROVIDER_MODELS = {};
export const PROVIDER_OAUTH = {};
export const PROVIDER_MEDIA = {};

for (const entry of REGISTRY) {
  if (entry.transport) {
    const t = { ...transport };
    if (!t.format) t.format = PROVIDER_DEFAULTS.format;
    PROVIDERS[entry.id] = buildTransport(entry.transport, entry.oauth);
    if (entry.transports) PROVIDERS[entry.id].transports = entry.transports;
  }
  if (entry.models !== undefined) 
    PROVIDER_MODELS[entry.alias || entry.id] = entry.models.map(normalizeModel);
  if (entry.oauth) PROVIDER_OAUTH[entry.id] = entry.oauth;
  
  // Build PROVIDER_MEDIA from media keys
  const mediaFields = {};
  const MEDIA_KEYS = new Set([/* 20+ media keys */]);
  for (const k of MEDIA_KEYS) {
    if (entry[k] !== undefined) mediaFields[k] = entry[k];
  }
  if (entry.media) Object.assign(mediaFields, entry.media);
  if (Object.keys(mediaFields).length) PROVIDER_MEDIA[entry.id] = mediaFields;
}
```

**Registry Entry Template** (`REGISTRY_TEMPLATE.js`):
```javascript
export default {
  id: "provider-id",           // REQUIRED - unique kebab-case id
  category: "apikey",          // REQUIRED - UI grouping
  uiAlias: "Provider Name",    // optional - shown in UI badges
  display: { /* UI config */ }, // optional
  transport: {                 // optional but recommended
    baseUrl: "https://api.example.com",
    format: "openai",
    headers: {},
    auth: { header: "Authorization", scheme: "bearer", source: ["accessToken"] },
    forceStream: false,
    urlSuffix: "",
    quirks: {},
    retry: /* retry config */,
    timeoutMs: /* timeout */,
    executor: "default"        // or specific executor name
  },
  oauth: { /* oauth config */ }, // optional
  media: {                     // optional - TTS/STT configs
    serviceKinds: ["tts"],
    ttsConfig: { baseUrl, authType, format, defaultModel, models },
    sttConfig: { /* ... */ }
  },
  models: ["model-1", "model-2"] // optional - explicit model list
};
```

### 1.2 How It Works

1. **Registry** (`open-sse/providers/registry/index.js`): Auto-generates import list from `providers/registry/{id}.js` files
2. **Providers index** (`open-sse/providers/index.js`): Consumes registry, builds production-facing data structures
3. **Services** (`open-sse/services/model.js`): Uses `PROVIDER_MODELS` + `resolveProviderAlias()` to resolve provider/model
4. **Executors** (`open-sse/executors/index.js`): Uses `PROVIDERS` to get transport config + `getExecutor()` to get executor instance

### 1.3 Adding a New Provider - Step by Step

**Step 1**: Copy `REGISTRY_TEMPLATE.js` → `open-sse/providers/registry/{id}.js`
```javascript
// Example: new provider "my-provider"
export default {
  id: "my-provider",
  category: "apikey",
  transport: {
    baseUrl: "https://api.my-provider.com/v1",
    format: "openai",
    auth: { header: "Authorization", scheme: "bearer", source: ["apiKey"] },
  },
  models: ["my-provider/model-1", "my-provider/model-2"],
};
```

**Step 2**: Add models to `open-sse/config/providerModels.js` if needed (auto-derived from registry)

**Step 3**: Run regeneration or manually verify `open-sse/providers/index.js` includes the new entry

**Step 4**: If non-standard upstream API, create executor in `open-sse/executors/{id}.js`

**Step 5**: If non-standard format, add `executor` field to transport config

### 1.4 Evidence from Codebase

- **138+ provider registry files** in `open-sse/providers/registry/` - each follows the template
- **`open-sse/providers/index.js`** builds `PROVIDERS` map from all registry entries
- **`open-sse/services/model.js`** `resolveProviderAlias()` derives provider IDs from aliases
- **`open-sse/executors/index.js`** maps provider names to executor instances, falls back to `DefaultExecutor`

---

## 2. Executor Subclass Pattern

### 2.1 Base Class Structure

**File**: `open-sse/executors/base.js`
**BaseExecutor** provides these methods:

```javascript
class BaseExecutor {
  constructor(provider) {
    this.provider = provider;
  }
  
  // Returns base URLs for the provider's API
  getBaseUrls(transport) {
    // Default: construct from transport.baseUrl + format-specific endpoints
    return {
      base: transport.baseUrl,
      // format-specific endpoints...
    };
  }
  
  // Builds HTTP request headers
  buildHeaders(transport) {
    return {
      [transport.auth.header]: `${transport.auth.scheme} ${/* token from credentials */}`,
      // ... additional headers
    };
  }
  
  // Constructs full API URL
  buildUrl(path, transport) {
    const base = this.getBaseUrls(transport).base;
    return new URL(path, base).href;
  }
  
  // Main execution method - streams upstream response
  async execute(request) {
    // Default implementation using fetch with streaming
    const url = this.buildUrl(request.path, request.transport);
    const headers = this.buildHeaders(request.transport);
    
    const init = {
      method: request.method || "POST",
      headers,
      body: JSON.stringify(request.body),
    };
    
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    // Stream response back
    return new StreamSSE(response.body, {
      headers: { "Content-Type": "text/event-stream" },
    });
  }
}
```

### 2.2 Specialized Executors

| Executor | Handles | Key Override |
|----------|---------|--------------|
| `AzureExecutor` | Azure OpenAI | `getBaseUrls()` - different endpoint format, `buildHeaders()` - API key in query param |
| `BedrockExecutor` | AWS Bedrock | `buildHeaders()` - Signature V4 auth, `buildUrl()` - regional endpoints |
| `GeminiCLIExecutor` | Gemini CLI | `execute()` - stdin-based input, different streaming model |
| `DefaultExecutor` | OpenAI-compatible | Default implementations of all methods |

### 2.3 Executor Registry

**File**: `open-sse/executors/index.js`
```javascript
const executors = {
  azure: new AzureExecutor(),
  bedrock: new BedrockExecutor(),
  // ... 30+ special providers
  // DefaultExecutor is auto-created for unknown providers
};

export function getExecutor(provider) {
  if (executors[provider]) return executors[provider];
  if (!defaultCache.has(provider)) 
    defaultCache.set(provider, new DefaultExecutor(provider));
  return defaultCache.get(provider);
}

export function hasSpecializedExecutor(provider) {
  return !!executors[provider];
}
```

### 2.4 Adding a New Executor - Step by Step

**Step 1**: Subclass `BaseExecutor` in `open-sse/executors/{id}.js`
```javascript
import { BaseExecutor } from "./base.js";

export class MyExecutor extends BaseExecutor {
  async execute(request) {
    // Custom implementation for provider's API
    // Must stream response in SSE format
    return super.execute(request); // or custom implementation
  }
  
  // Override as needed:
  // getBaseUrls(transport) { ... }
  // buildHeaders(transport) { ... }
  // buildUrl(path, transport) { ... }
}
```

**Step 2**: Register in `open-sse/executors/index.js`
```javascript
import MyExecutor from "./my.js";
executors.my-provider = new MyExecutor("my-provider");
```

**Step 3** (optional): Add `executor` field to provider's registry transport config

### 2.5 Evidence from Codebase

- **30+ executor files** in `open-sse/executors/` (azure.js, bedrock.js, gemini-cli.js, etc.)
- **`open-sse/executors/index.js`** maps 70+ provider names to executor instances
- **`DefaultExecutor`** auto-created for any provider not in the map
- **`getExecutor()`** caches instances per provider
- **`hasSpecializedExecutor()`** checks if a provider has a custom executor

---

## 3. Translator Registration via Side-Effects

### 3.1 Pattern Overview

**Core Mechanism**: Translator modules self-register via `register(from, to, reqFn, resFn)` called as a static import side-effect at the bottom of `translator/index.js`.

**Why this pattern**:
- Avoids manual registry maintenance
- Enables add-as-you-go translator addition
- Works with ESM and bundlers
- Handles circular import order via lazy var initialization

### 3.2 Index.js Initialization

**File**: `open-sse/translator/index.js` lines 14-31
```javascript
// Registry for translators. Lazy-init guards against circular-import order:
// translator modules call register() (side-effect) before this module's body runs.
// var (not let): hoisted as undefined so register() can run during circular import (no TDZ).
var requestRegistry;
var responseRegistry;

export function register(from, to, requestFn, responseFn) {
  requestRegistry ??= new Map();
  responseRegistry ??= new Map();
  const key = `${from}:${to}`;
  if (requestFn) {
    requestRegistry.set(key, requestFn);
  }
  if (responseFn) {
    responseRegistry.set(key, responseFn);
  }
}
```

**Why `var` instead of `let`**: Hoisted as `undefined` so `register()` calls during module evaluation can work without TDZ (temporal dead zone) issues.

### 3.3 How Translation Uses Registries

**Request Translation** (`translateRequest()`):
1. Check for direct route: `requestRegistry.get(`${sourceFormat}:${targetFormat}`)`
2. If found, use it (skips OpenAI pivot - "lossless for pairs like claude:kiro")
3. If not found, pivot through OpenAI: source→openai→target

**Response Translation** (`translateResponse()`):
1. Check for direct route: `responseRegistry.get(`${targetFormat}:${sourceFormat}`)`
2. If found, use it (e.g., kiro:claude converts Kiro's OpenAI-shaped chunks directly to Claude SSE)
3. If not found, pivot through OpenAI

### 3.4 Adding a New Translator - Step by Step

**Step 1**: Create the translator module
`open-sse/translator/request/{from}-to-{to}.js` or `open-sse/translator/response/{from}-to-{to}.js`

```javascript
// Example: translator/request/claude-to-openai.js
import { register } from "../index.js";
import { filterToOpenAIFormat } from "./openai.js";

register("claude", "openai", (model, body, stream, credentials) => {
  // Transform Claude message format → OpenAI Chat Completions format
  const openAIBody = {
    model,
    messages: body.messages.map(msg => ({
      role: msg.role,
      content: msg.content.map(part => 
        part.type === "text" ? { type: "text", text: part.text } :
        part.type === "tool_use" ? {
          type: "tool_use",
          tool_name: part.name,
          tool_args: part.input
        } : part
      ),
      tool_calls: body.tool_calls,
    })),
    stream,
    // ... other OpenAI fields
  };
  
  // Return transformed body (or stream directly)
  return openAIBody;
});
```

**Step 2**: Add import to `translator/index.js` bottom
```javascript
// At the bottom of translator/index.js, add:
import "./request/claude-to-openai.js";
```

**Step 3**: Test that translation works for the new pair

### 3.5 Direct Routes vs Pivot Routes

| Route Type | Description | Example |
|------------|-------------|---------|
| **Direct route** | Translator registered for exact source:target, skips OpenAI pivot | `claude:kiro` - avoids lossy double-hop |
| **Pivot route** | Translates source→openai→target if no direct translator exists | Default for most provider pairs |

**Direct route benefits**: 
- Lossless format conversion (no OpenAI bridge overhead)
- Preserves provider-specific fields (thinking, tool ids, etc.)
- Better performance (one fewer transformation step)

**Direct route requirements**:
- Must handle both request and response translation
- Must preserve all necessary fields for the target format
- Must be tested thoroughly

### 3.6 Evidence from Codebase

- **30+ translator files** in `open-sse/translator/request/` and `open-sse/translator/response/`
- **`translator/index.js`** bottom has 20+ static imports: `import "./request/claude-to-openai.js";` etc.
- **`translateRequest()`** and **`translateResponse()`** both check registries for direct routes first
- **Direct routes** documented: `claude:kiro`, `kiro:claude`, `openai-responses:codex`, etc.

---

## 4. Config-driven vs Hardcoded Values

### 4.1 Config-driven (Preferred Pattern)

**Sources of config-driven values**:

| Category | File | What it contains |
|----------|------|------------------|
| Provider definitions | `open-sse/providers/registry/{id}.js` | transport, models, oauth, media config |
| Model mappings | `open-sse/config/providerModels.js` | alias→id, model metadata |
| TTS configs | `open-sse/config/ttsModels.js` | models, voices, defaultModel per provider |
| Capability mappings | `open-sse/providers/capabilities.js` | PATTERN_CAPABILITIES, PROVIDER_CAPABILITIES |
| Runtime config | `open-sse/config/runtimeConfig.js` | timeouts, token limits, retry configs |
| Format handlers | `open-sse/handlers/ttsProviders/genericFormats.js` | FORMAT_HANDLERS by format name |

**Example: TTS Config-driven flow**
```
User calls /api/tts with {provider: "openai", model: "gpt-4o-mini-tts"}
→ handleTtsCore() calls getTtsAdapter("openai")
→ getTtsAdapter() returns null (openai not in SPECIAL_ADAPTERS - wait, it IS)
→ Actually: openai IS in SPECIAL_ADAPTERS, so adapter path taken
→ openai.js adapter.synthesize() called
→ Returns base64 audio

// OR if provider not in SPECIAL_ADAPTERS:
→ synthesizeViaConfig(provider, text, model, credentials)
→ Reads AI_PROVIDERS[provider]?.ttsConfig from @/shared/constants/providers
→ Uses TTS_MODELS_CONFIG[provider] for models/voices
→ Uses FORMAT_HANDLERS[cfg.format] for the actual API call
```

### 4.2 Hardcoded Violations

| Location | Hardcoded Value | Should Be |
|----------|----------------|-----------|
| `open-sse/handlers/ttsProviders/index.js:15-25` | `SPECIAL_ADAPTERS` with 9 provider→adapter mappings | Provider registry entries with `ttsAdapter` field |
| `open-sse/handlers/ttsCore.js:57-64` | Adapter dispatch: `if (getTtsAdapter(provider))` | Check provider registry for `ttsAdapter` field |
| `open-sse/handlers/ttsProviders/index.js:33` | `import("@/shared/constants/providers")` inside `synthesizeViaConfig()` | Module-level `import { AI_PROVIDERS } from "@/shared/constants/providers"` |
| `src/app/layout.js:28` | `fontPreconnect = "https://fonts.gstatic.com"` | Used in `<link rel="preconnect">` tag in HTML head |
| `src/app/layout.js:49` | `setTimeout(f, 1000)` | Configurable via env var or reduced to 500ms |

### 4.3 The SPECIAL_ADAPTERS Problem (ISSUE-001)

**Current code** (`open-sse/handlers/ttsProviders/index.js`):
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

**Problem**: 
- 9 providers hardcoded as string keys
- New TTS providers require code changes to `ttsProviders/index.js`
- Violates config-driven convention: "NEVER hardcode values, models, or block/role strings"

**Proposed Solution** (from ADR-001):
Move adapter registry to provider registry entries. Each provider entry gets an optional `ttsAdapter` field. For providers without `ttsAdapter`, fall through to the config-driven `synthesizeViaConfig` path.

**How it would work**:
1. Each provider registry entry (`open-sse/providers/registry/{id}.js`) gets:
```javascript
export default {
  id: "openai",
  category: "apikey",
  transport: { ... },
  ttsAdapter: "openai", // or the actual adapter module reference
  models: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
};
```

2. `getTtsAdapter(provider)` reads from registry instead of hardcoded map
3. `handleTtsCore()` checks registry first, falls back to `synthesizeViaConfig()`

### 4.4 The synthesizeViaConfig Dynamic Import (ISSUE-003)

**Current code** (`open-sse/handlers/ttsProviders/index.js:32-44`):
```javascript
export async function synthesizeViaConfig(provider, text, model, credentials) {
  const { AI_PROVIDERS } = await import("@/shared/constants/providers");
  const cfg = AI_PROVIDERS[provider]?.ttsConfig;
  // ... rest of function
}
```

**Problem**:
- Dynamic `import()` inside function body creates additional async boundary
- Inconsistent with pattern where `AI_PROVIDERS` is imported at top level elsewhere
- Module caching issues possible

**Proposed Solution**: Move import to module level
```javascript
import { AI_PROVIDERS } from "@/shared/constants/providers";
// Then in synthesizeViaConfig:
const cfg = AI_PROVIDERS[provider]?.ttsConfig;
// No await needed, import is synchronous at module level
```

### 4.5 Evidence from Codebase

- **`open-sse/config/providerModels.js`** builds `PROVIDER_MODELS` from registry (config-driven)
- **`open-sse/config/ttsModels.js`** defines `TTS_MODELS_CONFIG` with models/voices per provider (config-driven)
- **`open-sse/providers/capabilities.js`** has `PROVIDER_CAPABILITIES` and `PATTERN_CAPABILITIES` (config-driven)
- **`open-sse/config/runtimeConfig.js`** has timeouts, token limits (config-driven)
- **Violations**: `SPECIAL_ADAPTERS`, `handleTtsCore` dispatch, dynamic import in `synthesizeViaConfig`

---

## 5. Implementation Planning

### 5.1 Priority Order (from ADR)

1. **HIGH**: Move SPECIAL_ADAPTERS to provider registry entries (2-3 hours)
2. **HIGH**: Fix vitest alias resolution - update 5 test file imports to relative paths (1 hour)
3. **MEDIUM**: Move synthesizeViaConfig import to module level (1 hour)
4. **MEDIUM**: Refactor handleTtsCore to be more config-driven (1-2 hours)
5. **HIGH**: Add `<link rel="preconnect">` to layout head (5 min)
6. **MEDIUM**: Reduce font loading timeout from 1s to 500ms (5 min)

### 5.2 Detailed Implementation Plan

#### Phase 1: Quick Wins (1-2 days)

**Task 1.1**: Add font preconnect to layout.js
```diff
- // Preconnect to Google Fonts to reduce LCP
+ {/* Preconnect to Google Fonts to reduce LCP */}
+ <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
```

**Task 1.2**: Reduce font loading timeout
```diff
- setTimeout(f, 1000) // 1s timeout
+ setTimeout(f, 500) // 500ms timeout
```

**Task 1.3**: Fix vitest alias resolution
- Option A: Update 5 test files from `@/...` to relative paths (`../../../src/...`)
- Option B: Fix vitest config to use absolute `__dirname`

#### Phase 2: Medium-term (1-2 weeks)

**Task 2.1**: Move SPECIAL_ADAPTERS to provider registry
- Add `ttsAdapter` field to relevant registry entries
- Update `getTtsAdapter()` to read from registry
- Update `handleTtsCore()` to check registry first, fall back to config-driven

**Task 2.2**: Move synthesizeViaConfig import to module level
- Add `import { AI_PROVIDERS } from "@/shared/constants/providers";` at top of `ttsProviders/index.js`
- Remove dynamic `import()` from inside `synthesizeViaConfig()`
- Verify no circular dependency issues

**Task 2.3**: Refactor handleTtsCore adapter logic
- Remove hardcoded adapter check from `handleTtsCore`
- Route all providers through the registry-based `getTtsAdapter()`
- Ensure backward compatibility

#### Phase 3: Long-term (1 month)

**Task 3.1**: Full TypeScript migration for open-sse core files
- Add `.ts` extensions where beneficial
- Type the provider registry entries
- Type the executor base class and subclasses
- Type the translator request/response functions

**Task 3.2**: Implement drift prevention CI checklist (ADR-004)
- Import resolution test
- Full test suite
- Pattern logic verification
- Diff review enforcement

**Task 3.3**: Build provider registry schema validation tool
- Validate all registry entries conform to template
- Flag missing required fields
- Check for config-driven compliance
- Generate reports for CI

### 5.3 Code Change Examples

#### Example 1: Adding ttsAdapter to Provider Registry

**Before** (registry entry for openai):
```javascript
export default {
  id: "openai",
  category: "apikey",
  transport: {
    baseUrl: "https://api.openai.com/v1",
    format: "openai",
    auth: { /* ... */ },
  },
  models: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
};
```

**After**:
```javascript
export default {
  id: "openai",
  category: "apikey",
  transport: {
    baseUrl: "https://api.openai.com/v1",
    format: "openai",
    auth: { /* ... */ },
  },
  ttsAdapter: "openai", // maps to openai.js adapter in ttsProviders/
  models: ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"],
};
```

Then update `getTtsAdapter()`:
```javascript
export function getTtsAdapter(provider) {
  const entry = REGISTRY.find(r => r.id === provider || r.alias === provider);
  return entry?.ttsAdapter ? require(`../../ttsProviders/${entry.ttsAdapter}.js`) : null;
  // OR: return entry?.ttsAdapter || null; with manual mapping
}
```

#### Example 2: Moving synthesizeViaConfig Import

**Before**:
```javascript
export async function synthesizeViaConfig(provider, text, model, credentials) {
  const { AI_PROVIDERS } = await import("@/shared/constants/providers");
  const cfg = AI_PROVIDERS[provider]?.ttsConfig;
  // ...
}
```

**After** (top of file):
```javascript
import { AI_PROVIDERS } from "@/shared/constants/providers";

export async function synthesizeViaConfig(provider, text, model, credentials) {
  const cfg = AI_PROVIDERS[provider]?.ttsConfig;
  // ... no await needed
}
```

#### Example 3: Updating handleTtsCore

**Before**:
```javascript
export async function handleTtsCore({ provider, model, input, credentials, responseFormat = "mp3", language, style }) {
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

**After** (registry-based):
```javascript
export async function handleTtsCore({ provider, model, input, credentials, responseFormat = "mp3", language, style }) {
  // Check provider registry for adapter
  const adapter = getTtsAdapter(provider);
  if (adapter) {
    const result = await adapter.synthesize(input.trim(), model, credentials, responseFormat, { language, style });
    // ...
  }

  // All remaining providers go through config-driven path
  const result = await synthesizeViaConfig(provider, input.trim(), model, credentials);
  // ...
}
```

### 5.4 Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| **Breaking changes** to TTS API | Keep backward compatibility; `getTtsAdapter()` returns null for unrecognized providers, they fall through to config-driven path |
| **Circular dependencies** when moving imports | Use module-level imports; test with `node --experimental-modules`; verify no import loops |
| **Registry regeneration** breakage | Document the regeneration process; add `npm run fix:regenerate` script if needed |
| **Test failures** from import changes | Update all test imports; run full vitest suite; verify no regressions |
| **Performance impact** of registry lookups | Registry is small (150 entries); lookup is O(1) or O(n) with find(); negligible compared to TTS API calls |

### 5.5 Success Criteria

- [ ] All TTS providers work through either adapter or config-driven path
- [ ] No provider requires code changes to add TTS support (config-only)
- [ ] `synthesizeViaConfig` uses module-level import (no dynamic import inside function)
- [ ] `handleTtsCore` has no hardcoded provider lists
- [ ] All test imports resolve correctly in vitest
- [ ] Font preconnect and timeout fixes deployed
- [ ] Drift prevention CI checks passing

---
*This deep dive is based on analysis of: open-sse/AGENTS.md, ARCHITECTURE_AUDIT.json, ttsProviders/index.js, ttsCore.js, providers/index.js, executors/index.js, translator/index.js, and all related configuration files.*