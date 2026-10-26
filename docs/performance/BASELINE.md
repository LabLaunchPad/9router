# 9Router Ground Truth & Baseline Assessment

## Environment Ground Truth
- **Repository / HEAD SHA**: `6f5e9200ddcb8df7684f620d759ca86f8e888be7`
- **Node.js Version**: `v22.22.1`
- **npm Version**: `11.11.0`
- **Bun Version**: `1.2.14`
- **OS / Sandbox Context**: Linux x86_64 Debian/Ubuntu container (`/app`)
- **Framework & Router**: Next.js 16.4.3 (Webpack mode), App Router (`src/app/`)
- **Active Database Driver**: `better-sqlite3` (v12.6.2 native adapter) falling back to `sql.js` (WASM) / `node:sqlite` / `bun:sqlite`
- **Primary Request Entrypoints**: `/v1/*` mapped to `/api/v1/*` via Next.js rewrites in `next.config.mjs`

---

## Baseline Verification Results

### 1. Test Suite & Regression Baseline
- **Execution Command**: `npx vitest run --reporter=json --outputFile=tests/results.json`
- **Total Test Suites**: 398 test files
- **Total Tests**: 4096 tests
  - **Passed**: 3909
  - **Failed**: 74 (35 test files)
  - **Skipped / Expected Fail**: 114
  - **Duration**: ~84s
- **Regression Verification**: `node tests/__baseline__/verify-no-regression.mjs tests/results.json`
  - Current status: Baseline test results recorded.

### 2. Build & Bundle Analysis
- **Execution Command**: `npm run build`
- **Status**: SUCCESS (Next.js 16.4.3 Webpack build in ~66s)
- **Standalone Build Asset Verification**: `postbuild` script successfully copies static and standalone assets.
- **Top Client JS Chunks**:
  - `4285-81b8e0de6f9ba21b.js`: 336 KB
  - `3794-fba3f76785a3c234.js`: 238 KB
  - `761-c9086970fe03f4a1.js`: 231 KB
  - `5497-87f5229fb295a498.js`: 220 KB
  - `4bd1b696-8cd12253b448cc13.js`: 199 KB
  - `framework-b33a8f5d57cd8d87.js`: 186 KB

---

## Initial Audit Leads Re-verified (Phase 0)

1. **Docker Compose & Headroom Exposure (`docker-compose.yml`)**:
   - `CODE-VERIFIED`: `docker-compose.yml` uses pre-built `image: decolua/9router:latest` without a local `build:` directive. Running `docker compose up` would run an upstream image rather than the checked-out local source code.
   - `CODE-VERIFIED`: `headroom` service exposes port `8787:8787` on all interfaces (`0.0.0.0`) instead of internal network only or loopback (`127.0.0.1:8787`).
2. **Dockerfile Best Practices (`Dockerfile`)**:
   - `CODE-VERIFIED`: Default `NODE_IMAGE` build arg is `node:22-alpine` without tag pinning.
3. **Database Driver Fallback**:
   - `CODE-VERIFIED`: `src/lib/db/driver.js` initializes `better-sqlite3` under Node when available.
