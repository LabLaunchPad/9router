# Performance & Reliability Baseline

- **Repository:** `LabLaunchPad/9router`
- **Branch:** `jules-18013163180916925498-33a1d789`
- **HEAD SHA:** `6f5e9200ddcb8df7684f620d759ca86f8e888be7`
- **Environment:** Node.js v22.22.1, npm 11.11.0, Linux 6.6.137+
- **Database Driver Selected:** `better-sqlite3` (v12.6.2)
- **Active Framework/Build:** Next.js 16.4.3 (Webpack build via `next build --webpack`)

---

## Baseline Verification Summary

| Check / Tool | Status | Pass Count | Fail Count | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `npm test` (Vitest unit/integration) | ❌ Pre-existing Failures | 3909 passed | 74 failed (35 test files failed) | Pre-existing failures primarily in translator Edge cases and external live mocks |
| `npm run test:chaos` | ✅ Passed | 25 passed | 0 failed | 100% pass across account kill-switch, provider timeouts, stream corruption |
| `npm run build` | ✅ Passed | Clean build | 0 errors | Next.js standalone export + asset post-build script completed successfully |
| `docker-compose.yml` | ⚠️ Risk Identified | N/A | N/A | Image points to external `decolua/9router:latest` without `build:` context; Headroom port 8787 exposed globally |

---

## Baseline Metrics & Diagnostic Notes

- **Gateway Overhead:** Direct local mock tests indicate low gateway dispatch baseline (~1-5ms overhead for model alias resolution and account selection).
- **Database Initialization:** `better-sqlite3` selected successfully on Node 22; schema migration #1 applied smoothly without missing native bindings.
- **Client Bundles & Server Assets:** Dynamic static pages generated (151 routes); Monaco and React Flow identified in dependencies and routes.
