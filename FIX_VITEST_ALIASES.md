# Vitest Config Alias Fix

## Issue

Several test files use `@/...` imports that don't resolve properly when running vitest from certain directories:

**Affected test files and imports**:
- `tests/unit/bedrock-provider-api-secrets.test.js`:
  - `import "@/app/api/providers/route.js"`
  - `import "@/app/api/providers/[id]/route.js"`
  - `import "@/models/index.js"`
- `tests/unit/force-stream-config.test.js`:
  - `import "@/lib/dataDir.js"`
- `tests/unit/db-migration-chain.test.js`:
  - `import "@/lib/db/driver.js`

**Vitest config** (`tests/vitest.config.js`):
```javascript
{ find: /^@\//, replacement: resolve(__dirname, "../src") + "/" }
```

**Why it fails**: When running `npx vitest run` from `C:\9router` (root), the config loads from `C:\9router\tests\vitest.config.js`, but `__dirname` = `C:\9router\tests`, so the alias resolves correctly. However, there may be module resolution issues or caching causing the aliases to not work in all contexts.

## Fix Option 1: Update Test Imports to Relative Paths

**Most reliable fix** - change `@/app/api/providers/route.js` to relative path:
- `../../../src/app/api/providers/route.js` (from `tests/unit/bedrock-provider-api-secrets.test.js`)
- `../../../src/app/api/providers/[id]/route.js`
- `../../../src/models/index.js`
- `../../../src/lib/dataDir.js` (from `tests/unit/force-stream-config.test.js`)
- `../../../src/lib/db/driver.js` (from `tests/unit/db-migration-chain.test.js`)

**Pros**: Works regardless of vitest config or working directory
**Cons**: Requires updating import paths in each test file; relative paths are longer and more fragile to directory moves

## Fix Option 2: Fix Vitest Config

**Add absolute path resolution** that works regardless of cwd:

```javascript
// tests/vitest.config.js
import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["**/*.test.js"],
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**"],
    maxConcurrency: 60,
    silent: false,
  },
  resolve: {
    alias: [
      { find: /^open-sse\//, replacement: resolve(__dirname, "../open-sse") + "/" },
      { find: "open-sse", replacement: resolve(__dirname, "../open-sse") },
      // Use absolute path for @/ alias - always resolve from project root
      { 
        find: /^@\//, 
        replacement: resolve(__dirname, "../../src") + "/" 
      },
    ],
  },
});
```

**Pros**: Keeps `@/` imports, config fix works globally
**Cons**: May still have resolution issues depending on how vitest loads config

## Fix Option 3: Add Workspace Root Config

**Create vitest config at project root** that overrides tests config:

```json
// C:\9router\vitest.config.mjs
import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
  },
  resolve: {
    alias: {
      "@": resolve("./src"),
    },
  },
});
```

Then in `tests/vitest.config.js`, extend or override:
```javascript
import { mergeConfig } from "vitest/config";

export default mergeConfig({
  // ... existing config
  resolve: {
    alias: {
      "@": resolve("./src"),
    },
  },
});
```

**Pros**: Single source of truth for aliases
**Cons**: More complex config setup

## Recommended Fix: Option 1 (Relative Paths)

**Why**: Most reliable, works regardless of vitest configuration issues or working directory. The test files are already in `tests/unit/`, so relative paths are predictable.

### Updated Import Paths

| Test File | Old Import | New Import |
|-----------|-----------|--------|
| `bedrock-provider-api-secrets.test.js` | `@/app/api/providers/route.js` | `../../../src/app/api/providers/route.js` |
| `bedrock-provider-api-secrets.test.js` | `@/app/api/providers/[id]/route.js` | `../../../src/app/api/providers/[id]/route.js` |
| `bedrock-provider-api-secrets.test.js` | `@/models/index.js` | `../../../src/models/index.js` |
| `force-stream-config.test.js` | `@/lib/dataDir.js` | `../../../src/lib/dataDir.js` |
| `db-migration-chain.test.js` | `@/lib/db/driver.js` | `../../../src/lib/db/driver.js` |

### How to Apply

1. Open each affected test file
2. Replace `@/...` imports with the corresponding relative path
3. Run `npx vitest run` to verify imports resolve
4. Repeat for all affected files

### Verification

After fixing imports, run:
```bash
cd C:\9router\tests
npx vitest run tests/unit/bedrock-provider-api-secrets.test.js --reporter=verbose
```

Should show imports resolving correctly (no "Cannot find package" errors).

---

## Alternative: Keep `@/` Imports, Fix Config

If you prefer to keep `@/` imports, try this config fix:

```javascript
// In tests/vitest.config.js, ensure __dirname is correct
const __dirname = fileURLToPath(new URL(".", import.meta.url));
// __dirname will be C:\9router\tests

// The alias should then resolve:
// @/app/api/providers/route.js → C:\9router\tests\..\src\app\api\providers\route.js → C:\9router\src\app\api\providers\route.js
```

**Test**: Run `cd C:\9router\tests && npx vitest run` to ensure config loads from correct directory.

**If still failing**: Use Option 1 (relative paths) as the reliable fallback.