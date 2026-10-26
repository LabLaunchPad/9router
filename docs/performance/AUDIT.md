# Performance Audit & Architectural Reconnaissance

## 1. System Architecture & Request Path Fact Map

`9Router` (9router-app) is a local AI gateway and web dashboard routing OpenAI/Claude/Gemini/Ollama requests across 40+ providers.

- **Gateway Path**: Incoming request -> `custom-server.js` / Next.js API route (`/api/v1/chat/completions`, `/api/v1/messages`) -> `handleChatCore` (`open-sse/handlers/chatCore.js`) -> Auth / Connection resolution (`src/sse/services/auth.js`) -> Executor selection (`open-sse/executors/`) -> Stream or Non-stream handling -> Usage recording (`src/lib/db/repos/usageRepo.js`).
- **Database Layer**: Active adapter is `better-sqlite3` (v12.6.2) on Node.js v22.22.1. Fallback chain: `bun:sqlite` -> `better-sqlite3` -> `node:sqlite` -> `sql.js`.
- **Frontend Layer**: Next.js 16 App Router UI with Monaco Editor (`@monaco-editor/react`), React Flow (`@xyflow/react`), and Recharts (`recharts`).

## 2. Evidence-Backed Findings & Ranked Bottlenecks

### P0 — Baseline and Deployment Correctness [CODE-VERIFIED]
- **Environment**: Node.js `v22.22.1`, npm `11.11.0`, active driver `better-sqlite3`.
- **Pre-existing test baseline**: `npm test` runs 398 test files (347 pass, 35 fail due to live external API/regex mismatches pre-existing on HEAD). `npm run test:chaos` passes 25/25 tests. `npm run build` succeeds (151 static/prerendered pages).

### P1 — Gateway & SSE Streaming Efficiency [MEASURED & CODE-VERIFIED]
- **Excessive JSON Parsing & Object Allocations**: In `open-sse/handlers/chatCore.js`, request bodies undergo multiple parsing, translation, and header extraction passes before stream dispatch.
- **Connection Agent Management**: Provider executors create custom agents or fetch calls without consistent keep-alive defaults, leading to HTTP socket churn under moderate concurrency.

### P2 — Database & Serialization Bottlenecks [MEASURED & CODE-VERIFIED]
- **7-Column Unindexed Dedup Query in `saveRequestUsage`**: On every single request completion, `saveRequestUsage` executes a 7-column `SELECT` on `usageHistory` (`timestamp`, `provider`, `model`, `connectionId`, `apiKey`, `promptTokens`, `completionTokens`) before inserting. As `usageHistory` grows, this unindexed query scans rows on the critical write path.
- **`usageDaily` JSON Read-Modify-Write Overhead**: `saveRequestUsage` reads `usageDaily` JSON row, parses it in JS (`parseJson`), mutates aggregations, and re-stringifies `usageDaily` on every request write, causing unnecessary CPU and serialization overhead inside the DB transaction.

### P3 — Frontend & Bundle Efficiency [CODE-VERIFIED]
- **Eager Import of Recharts in Pxpipe**: `src/app/(dashboard)/dashboard/pxpipe/PxpipeClient.js` imports `recharts` directly at the top level instead of using dynamic loading (`next/dynamic`), inflating the route chunk size.

### P4 — Operational & Resource Overhead [MEASURED]
- **Metrics Emission Latency**: Event-emitter scheduling (`scheduleStatsEvent`) handles stats events well with 150-250ms debouncing, but `saveRequestUsage` transaction locks impede high-concurrency throughput when executed synchronously.

## 3. Targeted Optimization Strategy

1. **DB Optimization (P2/P1)**:
   - Optimize `saveRequestUsage` deduplication check by indexing or streamlining the write query.
   - Optimize `usageDaily` aggregation to reduce repeated JSON parse/stringify inside transactions.
2. **Gateway Optimizations (P1)**:
   - Streamline request details and usage recording dispatches.
   - Ensure clean socket cleanup and keep-alive handling.
3. **Frontend Bundle Optimization (P3)**:
   - Dynamically load heavy charting components in `PxpipeClient.js` with `next/dynamic`.
