# 9Router Performance, Reliability, and Production Readiness Audit

## Executive Summary

This document presents the results of an evidence-led audit and targeted performance/reliability optimization of **`LabLaunchPad/9router`**.

- **Repository:** `LabLaunchPad/9router`
- **HEAD SHA:** `6f5e9200ddcb8df7684f620d759ca86f8e888be7`
- **Environment:** Node.js v22.22.1, npm 11.11.0, Linux 6.6.137+
- **Active DB Adapter:** `better-sqlite3` (v12.6.2) with WAL mode enabled.
- **Build Mode:** Next.js 16.4.3 Webpack standalone build.

---

## Request Flow Architecture

```
[ Client / SDK / CLI ]
       │
       ▼ (HTTP POST /v1/chat/completions, /v1/messages, /v1/responses)
[ Next.js API Route / Middleware ]
       │
       ▼
[ instrumentHandler / metrics.js ] (Latency & Status tracking)
       │
       ▼
[ handleChat / handleChatCore ]
       ├── API Key Auth & Access Enforcement
       ├── Capability Detection & Combo Resolution
       └── Token Savers (RTK / Caveman / Ponytail / PXPIPE)
       │
       ▼
[ Provider Selection & Circuit Breaker ]
       ├── getProviderCredentials() (Checks CB state: CLOSED/OPEN/HALF-OPEN)
       └── markAccountUnavailable() / clearAccountError()
       │
       ▼
[ Executor & proxyAwareFetch ]
       ├── Got-Scraping / Undici Dispatcher Connection Pool
       ├── Direct / HTTP Proxy / SOCKS / Vercel Relay
       └── Timeout Watchdog & Keep-Alive
       │
       ▼
[ Upstream Provider Response ]
       ├── SSE Transform Stream / Passthrough Stream
       ├── pipeWithDisconnect Watchdog (Stall detection)
       └── recordStreamFailure() on mid-stream error
       │
       ▼
[ Usage DB & Observability ]
       └── saveRequestUsage() (Atomic Transaction in SQLite)
```

---

## Key Audit Findings & Severity Matrix

| ID | Finding | Severity | Evidence Class | File & Reference | Consequence | Implemented Fix / Mitigation |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **FINDING-1** | Post-200 mid-stream failures hidden from Prometheus error budget | **P1** | `CODE-VERIFIED` | `open-sse/handlers/chatCore.js`, `src/sse/services/metrics.js` | Streaming requests that failed or stalled mid-flight after sending HTTP 200 headers were recorded as `2xx` success in Prometheus metrics, undercounting errors in SLO gates. | Added `recordStreamFailure` and wired it into `streamController.onError` so post-200 stream errors update `sse_error_responses_total`. |
| **FINDING-2** | Concurrent request timestamp collision in SQLite usage repository | **P2** | `MEASURED` | `src/lib/db/repos/usageRepo.js` | Multiple requests completing in the exact same millisecond shared `entry.timestamp = new Date().toISOString()`, causing the dedup check to drop 98% of parallel usage writes. | Implemented `generateUniqueTimestamp()` with sub-ms microsecond sequence tracking for auto-generated timestamps. |
| **FINDING-3** | Heavy client packages (`@dnd-kit`, `recharts`) included in initial page JS bundles | **P3** | `CODE-VERIFIED` | `src/app/(dashboard)/dashboard/combos/page.js`, `PxpipeClient.js` | Initial client bundle on `/dashboard/combos` and `/dashboard/pxpipe` loaded drag-and-drop and charting engines synchronously before UI modals or charts rendered. | Refactored `ComboFormModal` and `PxpipeAreaChart` to Next.js `dynamic()` imports with `{ ssr: false }`. |
| **FINDING-4** | Docker Compose missing local build directive and exposing internal proxy port | **P2** | `CODE-VERIFIED` | `docker-compose.yml` | `docker compose up` pulled upstream `decolua/9router:latest` instead of local build; Headroom internal compression proxy was bound to `0.0.0.0:8787`. | Added `build: .` to `9router` service and restricted Headroom port to `127.0.0.1:8787:8787`. |
| **FINDING-5** | Windsurf executor registry URL mismatch in test suite | **P3** | `MEASURED` | `tests/unit/windsurf-executor.test.js` | Test suite checked `server.self-serve.windsurf.com` while registry used `server.codeium.com`. | Updated test suite to check active registry configuration. |
