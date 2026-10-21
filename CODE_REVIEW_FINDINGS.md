# 9Router Deep Code Review Findings & Architectural Assessment

_Date: March 9, 2026_
_Scope: Full repository analysis (src/, open-sse/, cli/, custom-server.js, db layer, security, SRE, and API compatibility)_

---

## Executive Summary

9Router is an ambitious and capability-dense AI gateway & routing proxy supporting over 40 providers and dozens of specialized executors and translation routes. During this deep multi-perspective code review—evaluating the codebase through 6 distinct engineering lenses (**Security Auditor**, **SRE / Reliability Engineer**, **API Compatibility & Protocol Engineer**, **Database & State Engineer**, **Code Maintainability & DX Architect**, and **Performance / Optimization Specialist**)—we identified critical vulnerabilities, reliability risks, protocol edge-cases, and maintenance debt.

This document details the evidence-based findings, root causes, risks, and recommended remediations.

---

## 🔍 Persona / Lens Index of Findings

### 1. 🛡️ Security Auditor Findings

#### **[CRITICAL] SEC-01: Default Password Unauthenticated Remote Bypasses & Risk Matrix**
* **Location:** `src/app/api/auth/login/route.js`, `src/dashboardGuard.js`, `src/app/api/auth/reset-password/route.js`
* **Evidence:**
  In `src/app/api/auth/login/route.js`:
  ```javascript
  const mustChangePassword = !storedHash && !process.env.INITIAL_PASSWORD && !isLocalRequest(request);
  if (mustChangePassword) {
    return NextResponse.json(
      { success: false, error: "Default password must be changed before remote access...", mustChangePassword },
      { status: 403 }
    );
  }
  ```
  While the remote password login route rejects remote authentication when using the default password (`123456`), `src/app/api/auth/reset-password/route.js` clears `settings.password` unconditionally if called locally:
  ```javascript
  export async function POST() {
    await updateSettings({ password: null });
    return NextResponse.json({ success: true });
  }
  ```
  Furthermore, `dashboardGuard.js` allows public access to `/api/settings/require-login`. If `requireLogin` is set to `false`, all `/api/*` management endpoints become publicly accessible without authentication.
* **Risk:**
  If an attacker accesses a host deployed with `requireLogin: false` or accesses remote APIs without explicit API keys, administrative configuration and OAuth access tokens can be extracted.
* **Remediation:**
  Enforce strict Bearer token requirement (`REQUIRE_API_KEY=true`) on all non-loopback `/v1/*` and `/api/*` endpoints by default.

---

#### **[HIGH] SEC-02: Missing SSRF Filtering on User-Defined Proxy Pools & Upstream Base URLs**
* **Location:** `open-sse/utils/proxyFetch.js`, `src/lib/mimoLoginSession.js`, `src/app/api/mcp/`
* **Evidence:**
  User-configured provider connection `baseUrl` and proxy pool endpoints (`connectionProxyUrl`) allow arbitrary HTTP/HTTPS URLs. When 9Router executes requests to these upstreams, it performs `fetch()` without verifying whether the target resolves to private/internal IP ranges (`127.0.0.1`, `10.0.0.0/8`, `169.254.169.254`, `::1`).
* **Risk:**
  An attacker with access to dashboard settings (or via CSRF if dashboard auth is disabled) can configure a custom provider node pointing to cloud instance metadata (`http://169.254.169.254/latest/meta-data/`) or local network services, causing 9Router to perform Server-Side Request Forgery (SSRF) and leak internal data in model responses or request logs.
* **Remediation:**
  Implement DNS pre-resolution validation in `proxyFetch.js` to block internal/loopback IP address ranges unless explicitly allowed by environment configuration (`ALLOW_INTERNAL_UPSTREAMS=true`).

---

#### **[MEDIUM] SEC-03: Excessive Sensitive Data Exposure in Request Detail Logging**
* **Location:** `open-sse/handlers/chatCore/requestDetail.js`, `open-sse/utils/requestLogger.js`
* **Evidence:**
  When `ENABLE_REQUEST_LOGS=true`, full request/response bodies—including authorization headers, bearer tokens, and user prompt payloads—are written unmasked to disk under `<DATA_DIR>/logs/` and recorded in SQLite `requestDetails`.
* **Risk:**
  Disk exposure of sensitive credentials, API keys, and private user conversation data if log files or SQLite files are read by unauthorized local users or exposed via backup downloads.
* **Remediation:**
  Sanitize `Authorization`, `x-api-key`, and provider-specific access token fields before persisting request details and debug log files.

---

### 2. ⚡ SRE & Reliability Engineer Findings

#### **[HIGH] SRE-01: Global Cooldown Locking Locks All Provider Accounts on Transient Network Errors**
* **Location:** `open-sse/services/accountFallback.js`
* **Evidence:**
  ```javascript
  // Default: transient cooldown for any unmatched error
  return { shouldFallback: true, cooldownMs: TRANSIENT_COOLDOWN_MS };
  ```
  In `accountFallback.js`, any unmatched upstream error (including transient socket timeouts or 5xx server errors) sets a cooldown on the provider account (`rateLimitedUntil`). If a user has a single provider connection configured, a single transient network failure locks out the entire provider account for 60 seconds.
* **Risk:**
  Unnecessary service outages for single-account setups when minor network blips occur. Consecutive requests will fail with "all accounts locked" errors instead of retrying or attempting the request.
* **Remediation:**
  Distinguish between account-level auth/quota errors (401, 402, 429) and transient network/HTTP 502/503 errors. For transient 5xx errors, retry with exponential backoff before applying account cooldowns.

---

#### **[HIGH] SRE-02: SQLite Unhandled Database Lock Concurrency Under Heavy SSE Traffic**
* **Location:** `src/lib/db/driver.js`, `src/lib/db/repos/usageRepo.js`
* **Evidence:**
  Under high parallel request loads, multiple concurrent SSE stream chunk completions invoke `saveRequestUsage()` and `appendRequestLog()`. In environments using `better-sqlite3` or `node:sqlite` without Write-Ahead Logging (WAL) enabled or proper busy-timeout retry handlers, SQLite throws `SqliteError: database is locked`.
* **Risk:**
  Request usage stats dropped, lost metrics, or HTTP 500 error responses returned to clients mid-stream.
* **Remediation:**
  Explicitly execute `PRAGMA journal_mode = WAL;` and `PRAGMA busy_timeout = 5000;` on SQLite connection initialization in `driver.js`.

---

### 3. 🌐 API Compatibility & Protocol Engineer Findings

#### **[MEDIUM] API-01: Incomplete Handling of Claude / OpenAI Non-Standard Tool Call Format Differences**
* **Location:** `open-sse/translator/formats/claude.js`, `open-sse/translator/concerns/toolCall.js`
* **Evidence:**
  Some upstream providers (such as MiniMax, DeepSeek, and Kiro) expect strict tool definitions. In `shouldDefaultClaudeToolType`, missing `type` fields in tool parameters cause HTTP 400 rejection from MiniMax, while adding `type: "custom"` causes HTTP 400 rejection on DeepSeek's Anthropic-compatible endpoints.
* **Risk:**
  Inconsistent tool call execution depending on which upstream provider is selected in a model combo.
* **Remediation:**
  Maintain explicit per-provider tool schema normalization flags in `open-sse/config/providers.js` rather than relying on heuristic detection during translation.

---

#### **[MEDIUM] API-02: Missing Handling for SSE Stream Disconnects on Long-Running Reasonings**
* **Location:** `open-sse/utils/streamHandler.js`
* **Evidence:**
  When a CLI tool cancels or disconnects an HTTP SSE stream during extended reasoning/thinking generation, `streamController` triggers cleanup but upstream HTTP requests are not always cancelled immediately if the provider executor does not properly pass `signal` to `proxyFetch`.
* **Risk:**
  Orphaned upstream requests continue consuming provider quota and background tokens long after the client has disconnected.
* **Remediation:**
  Ensure all executor `execute()` functions attach `streamController.signal` or `options.signal` to `fetch()` calls.

---

### 4. 🗄️ Database & State Engineer Findings

#### **[MEDIUM] DB-01: Asymmetric Storage Paths Between `DATA_DIR` and `usage.json` / `log.txt`**
* **Location:** `src/lib/dataDir.js`, `src/lib/db/paths.js`, `src/lib/usageDb.js`
* **Evidence:**
  While SQLite state respects the `DATA_DIR` environment variable, legacy usage paths in `usageDb.js` hardcode paths relative to `~/.9router/usage.json`.
* **Risk:**
  Docker containers with custom `DATA_DIR` volume mounts miss usage logs and request history backups if `~/.9router` is not mounted.
* **Remediation:**
  Unify all storage path resolution under `src/lib/dataDir.js` so `DATA_DIR` governs SQLite DB, usage metrics, and logs uniformly.

---

### 5. 🛠️ Code Maintainability & DX Architect Findings

#### **[LOW] MAINT-01: Unused Dependency & Configuration Artifacts**
* **Location:** `package.json`, `tests/package.json`
* **Evidence:**
  `tests/package.json` contains hardcoded Unix environment path variables (`NODE_PATH=/tmp/node_modules`), causing `npm test` failures on non-Linux platforms or standard developer environments.
* **Remediation:**
  Standardize `tests/package.json` test script to use cross-platform path resolution via `vitest`.

---

## 🛠️ Summary Action Plan & Recommendations

1. **Security Hardening:** Enable mandatory API key validation for remote access (`REQUIRE_API_KEY=true`), sanitize sensitive headers in request logs, and add SSRF checks on proxy pool and node URLs.
2. **Reliability & SRE:** Configure SQLite WAL mode and busy timeouts (`PRAGMA journal_mode = WAL`); refine account cooldown logic to avoid locking healthy connections on transient 5xx/network errors.
3. **Protocol & Compatibility:** Standardize tool call type injections across provider adapters and enforce strict AbortController signal propagation in all provider executors.
