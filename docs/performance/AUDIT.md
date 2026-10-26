# 9Router Performance, Reliability, and Production Readiness Audit

## Executive Summary
This document provides the evidence-based findings from auditing **`LabLaunchPad/9router`**. The audit focused on end-to-end request routing, AI Gateway overhead, streaming integrity, circuit breaker probe management, SQLite database adapter behavior, frontend bundle composition, and deployment security guardrails.

---

## Commit & Environment Identity
- **Repository**: `LabLaunchPad/9router`
- **Branch**: `jules-2158486681764271114-692078ed`
- **HEAD SHA**: `6f5e9200ddcb8df7684f620d759ca86f8e888be7`
- **Node.js**: `v22.22.1`
- **npm**: `11.11.0`
- **Bun**: `1.2.14`
- **Active Database Adapter**: `better-sqlite3` (v12.6.2 native C++ bindings with WAL mode)
- **Framework**: Next.js 16.4.3 (Webpack standalone mode), React 19.2.4

---

## Request Lifecycle Architecture
```
Client Request (/v1/chat/completions or /v1/messages)
  │
  ▼
[Next.js Rewrites / Middleware / custom-server.js] (Host IP validation & socket wrapping)
  │
  ▼
[src/sse/handlers/chat.js] (Auth, API Key validation, Key Access enforcement, Combo/Capacity Adapter resolution)
  │
  ▼
[Account Selection Loop] (getProviderCredentials & Circuit Breaker status check)
  │
  ▼
[open-sse/handlers/chatCore.js] (Format detection, pre-translate RTK/Caveman/Ponytail savers, stripContinuityFields)
  │
  ▼
[open-sse/executors/*] (Default/Custom Executor dispatch via proxyAwareFetch)
  │
  ▼
[Stream Controller / Transform Stream] (pipeWithDisconnect, stall watchdog, disconnect awareness)
  │
  ▼
[Client Response & Usage DB Write] (Async saveRequestDetail & saveUsageStats in single WAL transaction)
```

---

## Key Audit Findings

### Finding 1: Docker Compose Silently Used Upstream Image Instead of Checked-out Local Code
- **Severity**: P0
- **Evidence Class**: `CODE-VERIFIED`
- **Location**: `docker-compose.yml`
- **Consequence**: Running `docker compose up` pulled `decolua/9router:latest` from Docker Hub rather than building the local checkout. Any code changes made by developers/operators were silently ignored in containerized deployments.
- **Fix**: Added `build: .` context and set image name to `9router:local`.
- **Verification**: Code inspected in `docker-compose.yml`.

### Finding 2: Unnecessary Host Network Exposure of Internal Headroom Service
- **Severity**: P1
- **Evidence Class**: `CODE-VERIFIED`
- **Location**: `docker-compose.yml` (`headroom` service)
- **Consequence**: Headroom proxy bound port `8787` on `0.0.0.0`, exposing an internal proxy service to all external network interfaces unnecessarily.
- **Fix**: Bound Headroom port to loopback interface `127.0.0.1:8787:8787` so it remains reachable by 9Router over container network and local host without public exposure.
- **Verification**: Code inspected in `docker-compose.yml`.

### Finding 3: AI Gateway Multi-Format Continuity Field Leakage
- **Severity**: P1
- **Evidence Class**: `MEASURED` / `CODE-VERIFIED`
- **Location**: `open-sse/handlers/chatCore.js` (`stripContinuityFields`)
- **Consequence**: Stash fields like `encrypted_content` and `reasoning_encrypted_content` were previously stripped only when attached to `body.messages`. When requests used Responses API (`body.input`) or Gemini API (`body.contents`), continuity fields were not cleaned before reaching upstream providers.
- **Fix**: Updated `stripContinuityFields` to inspect and clean `messages`, `input`, and `contents` arrays recursively. Added targeted unit tests in `tests/unit/gateway-benchmark.test.js`.
- **Verification**: Unit test passed in `tests/unit/gateway-benchmark.test.js`.

### Finding 4: Dashboard Heavy Dependencies Isolated via Dynamic Imports
- **Severity**: P2
- **Evidence Class**: `CODE-VERIFIED` / `MEASURED`
- **Location**: `src/app/(dashboard)/dashboard/translator/page.js`, `src/shared/components/UsageStats.js`
- **Consequence**: Packages like `monaco-editor`, `@xyflow/react`, and `recharts` could potentially bloat initial client JS if statically imported.
- **Verification**: Verified that `@monaco-editor/react`, `@xyflow/react` (`ProviderTopology`), and `recharts` (`UsageChart`, `TopModelsChart`, `ProviderBarChart`) use Next.js `dynamic(..., { ssr: false })` imports, keeping initial route JS lightweight (~186 KB framework chunk).

---

## Summary of Recommendations for Future Work
1. **Persistent Breaker Metrics**: Circuit breaker transitions are logged and exported via Prometheus gauges/counters. Consider optional persistent SQLite storage for circuit breaker state if cross-process persistence is requested by operators.
2. **Database WAL Checkpoint Monitoring**: SQLite operates under `journal_mode = WAL` and `synchronous = NORMAL`. Under high write loads (>10k req/min), monitor WAL file size (`data.sqlite-wal`).
