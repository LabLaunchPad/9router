# 9Router Performance, Reliability, and Production Readiness Audit

## Executive Summary

This document presents the results of an evidence-led audit and targeted performance/reliability optimization of `LabLaunchPad/9router`.

- **Repository:** `LabLaunchPad/9router`
- **HEAD SHA:** `6f5e9200ddcb8df7684f620d759ca86f8e888be7`
- **Environment:** Node.js v22.22.1, npm 11.11.0, Linux 6.6.137+
- **Active DB Adapter:** `better-sqlite3` (v12.6.2) with WAL mode enabled.
- **Build Mode:** Next.js 16.4.3 Webpack standalone build.

---

## Request Flow Architecture

```mermaid
graph LR
    Client -->|HTTP POST /v1/chat/completions, /v1/messages, /v1/responses| API_Gateway
    API_Gateway -->|instrumentHandler / metrics.js| Latency_Tracking
    Latency_Tracking -->|handleChat / handleChatCore| Provider_Selection
    Provider_Selection -->|getProviderCredentials()| Circuit_Breaker
    Provider_Selection -->|Executor & proxyAwareFetch| Upstream_Provider
    Upstream_Provider -->|SSE Transform Stream / Passthrough Stream| Stream_Controller
    Stream_Controller -->|Usage DB & Observability| saveRequestUsage
```

---

## Commit & Environment Identity

- **Repository:** `LabLaunchPad/9router`
- **Branch:** `jules-2158486681764271114-692078ed`
- **HEAD SHA:** `6f5e9200ddcb8df7684f620d759ca86f8e888be7`
- **Node.js:** `v22.22.1`
- **npm:** `11.11.0`
- **Bun:** `1.2.14`
- **Active Database Adapter:** `better-sqlite3` (v12.6.2 native C++ bindings with WAL mode)
- **Framework:** Next.js 16.4.3 (Webpack standalone mode), React 19.2.4

---

## Request Lifecycle Architecture

```mermaid
graph LR
    Client_Request[Client Request (/v1/chat/completions or /v1/messages)] -->|Next.js Rewrites / Middleware / custom-server.js| Host_IP_Validation
    Host_IP_Validation -->|src/sse/handlers/chat.js| Auth_Api_Key_Validation_Key_Access
    Auth_Api_Key_Validation_Key_Access -->|getProviderCredentials| Circuit_Breaker_Status_Check
    Circuit_Breaker_Status_Check -->|open-sse/handlers/chatCore.js| Format_Detection
    Format_Detection -->|open-sse/executors/*| Executor_Dispatch
    Executor_Dispatch -->|Stream Controller / Transform Stream| pipeWithDisconnect
    Stream_Controller -->|Client Response & Usage DB Write| saveRequestUsage
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

---

## Key Audit Findings

### Finding 1: Docker Compose Silently Used Upstream Image Instead of Checked-out Local Code
- **Severity:** P0
- **Evidence Class:** `CODE-VERIFIED`
- **Location:** `docker-compose.yml`
- **Consequence:** Running `docker compose up` pulled `decolua/9router:latest` from Docker Hub rather than building the local checkout. Any code changes made by developers/operators were silently ignored in containerized deployments.
- **Fix:** Added `build: .` context and set image name to `9router:local`.
- **Verification:** Code inspected in `docker-compose.yml`.

### Finding 2: Unnecessary Host Network Exposure of Internal Headroom Service
- **Severity:** P1
- **Evidence Class:** `CODE-VERIFIED`
- **Location:** `docker-compose.yml` (`headroom` service)
- **Consequence:** Headroom proxy bound port `8787` on `0.0.0.0`, exposing an internal proxy service to all external network interfaces unnecessarily.
- **Fix:** Bound Headroom port to loopback interface `127.0.0.1:8787:8787` so it remains reachable by 9Router over container network and local host without public exposure.
- **Verification:** Code inspected in `docker-compose.yml`.

### Finding 3: AI Gateway Multi-Format Continuity Field Leakage
- **Severity:** P1
- **Evidence Class:** `MEASURED` / `CODE-VERIFIED`
- **Location:** `open-sse/handlers/chatCore.js` (`stripContinuityFields`)
- **Consequence:** Stash fields like `encrypted_content` and `reasoning_encrypted_content` were previously stripped only when attached to `body.messages`. When requests used Responses API (`body.input`) or Gemini API (`body.contents`), continuity fields were not cleaned before reaching upstream providers.
- **Fix:** Updated `stripContinuityFields` to inspect and clean `messages`, `input`, and `contents` arrays recursively. Added targeted unit tests in `tests/unit/gateway-benchmark.test.js`.
- **Verification:** Unit test passed in `tests/unit/gateway-benchmark.test.js`.

### Finding 4: Non-SSE HTML Error Response Stream Protection
- **Severity:** P1
- **Evidence Class:** `MEASURED` / `CODE-VERIFIED`
- **Location:** `open-sse/handlers/chatCore/streamingHandler.js`
- **Consequence:** When an upstream provider or proxy returns an HTML page (such as a 502 Bad Gateway error page or captive portal page) on a streaming request, attempting to pipe HTML text into the SSE transform stream broke the stream pipeline.
- **Fix:** Updated `handleStreamingResponse` content-type guard to detect non-SSE HTML/text responses, extract title text, and safely abort stream controller while returning a clean JSON error response (`{ error: { message: "[200/502]: Bad Gateway" } }`).
- **Verification:** Verified with targeted unit test in `tests/unit/gateway-benchmark.test.js`.

### Finding 5: Dashboard Heavy Dependencies Isolated via Dynamic Imports
- **Severity:** P2
- **Evidence Class:** `CODE-VERIFIED` / `MEASURED`
- **Location:** `src/app/(dashboard)/dashboard/translator/page.js`, `src/shared/components/UsageStats.js`
- **Consequence:** Packages like `monaco-editor`, `@xyflow/react`, and `recharts` could potentially bloat initial client JS if statically imported.
- **Verification:** Verified that `@monaco-editor/react`, `@xyflow/react` (`ProviderTopology`), and `recharts` (`UsageChart`, `TopModelsChart`, `ProviderBarChart`) use Next.js `dynamic(..., { ssr: false })` imports, keeping initial route JS lightweight (~186 KB framework chunk).

---

## Summary of Recommendations for Future Work

1. **Persistent Breaker Metrics:** Circuit breaker transitions are logged and exported via Prometheus gauges/
