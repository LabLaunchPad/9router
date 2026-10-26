# Baseline Performance & Operational State

## 1. Environment & Runtime Facts

- **Repository Branch**: `jules-10842623331805503799-4c9672d7`
- **HEAD Commit**: `6f5e9200ddcb8df7684f620d759ca86f8e888be7`
- **Runtime Version**: Node.js `v22.22.1`
- **Package Manager**: npm `11.11.0`
- **Active SQLite Driver**: `better-sqlite3` (v12.6.2)
  - Fallback Chain: `bun:sqlite` -> `better-sqlite3` -> `node:sqlite` -> `sql.js`

## 2. Baseline Test Results

| Command | Status | Total Files | Passed Files | Failed Files | Skipped Files | Total Tests | Passed Tests | Failed Tests | Skipped/Expected Fail |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `npm test` | Completed | 398 | 347 | 35 | 16 | 4096 | 3909 | 74 | 112 |
| `npm run test:chaos` | Passed | 1 | 1 | 0 | 0 | 25 | 25 | 0 | 0 |
| `npm run build` | Passed | N/A | Success | 0 | 0 | 151 pages | 151 | 0 | 0 |

### Pre-Existing Test Failures (Recorded Untouched Baseline)
- `tests/unit/mimo-free.live.test.js`: Chat WITH Chrome User-Agent
- `tests/unit/security-audit.test.js`: Source template regex checks
- `tests/unit/translator-helpers-edge.test.js`: Mid-conversation system message hoisting
- `tests/unit/translator-request-normalization.test.js`: Text content array flattening
- `tests/unit/windsurf-executor.test.js`: Base URL matching

## 3. Production Build & Bundle Baseline

- **Next.js Version**: 16.4.3
- **Build Target**: Standalone server (`custom-server.js`)
- **Compilation Time**: 61s
- **Static Pages Prerendered**: 151/151
