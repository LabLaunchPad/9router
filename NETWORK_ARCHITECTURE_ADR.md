# Network Architecture ADR: 9router

**Date:** 2026-10-19
**Author:** Network Subagent
**Status:** APPROVED

---

## 1. Overview

This ADR documents the network architecture of the 9router application, covering custom server setup, outbound proxy strategy, connection pooling, network error handling, and DNS resolution. The architecture enables flexible proxy routing for AI provider requests while maintaining control-plane visibility and data-plane security.

---

## 2. Custom Server Model

### 2.1 `custom-server.js` (Entry Point)

**Purpose:** Wrap Next.js standalone HTTP server to sanitize client-supplied forwarding headers and handle H2C upgrades.

**Key Behaviors:**

- Derives client IP from TCP socket (unspoofable) rather than X-Forwarded-For
- Strips client-supplied `x-9r-real-ip`, `x-forwarded-for`, `x-9r-via-proxy`, `x-9r-peer-token` headers
- Sets `x-9r-real-ip` to the real peer address (or forwarding header value if peer is loopback)
- Strips H2C upgrade headers and forces `connection: close` for HTTP/1.1 compatibility
- Starts background token refresh on server listening

**Code Flow:**
```
Client Request
    → custom-server.js wrapper
    → Header sanitization (strip/spoof checks)
    → Next.js standalone server
    → SSE handler → open-sse pipeline
```

**Risk:** If the TCP peer is NOT a local reverse proxy, the real client IP is used directly — forwarding headers are untrusted. This prevents XFF spoofing but requires that any reverse proxy (Cloudflare, NGINX, etc.) sets `x-real-ip` correctly.

---

## 3. Outbound Proxy Strategy

### 3.1 Proxy Configuration Sources

Proxy settings are resolved in priority order:

1. **Proxy Pool** — `providerSpecificData.proxyPoolId` (active pool with URL)
2. **Legacy Proxy** — `providerSpecificData.connectionProxyUrl` + `connectionProxyEnabled`
3. **No Proxy** — explicit bypass

### 3.2 Proxy Pool Types

| Type | Behavior | Usage |
|------|----------|-------|
| `http` | Standard undici ProxyAgent with `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` env vars | General upstream API calls |
| `vercel` | Vercel relay — uses base URL rewriting + `x-relay-target`/`x-relay-path` headers | Vercel deployment bypass |
| `cloudflare` | Cloudflare relay — similar URL rewriting pattern | Cloudflare deployment bypass |
| `deno` | Deno Deploy relay | Deno deployment bypass |
| `netlify` | Netlify relay | Netlify deployment bypass |

### 3.3 Environment Variable Management

`outboundProxy.js` manages `process.env`:

- `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` — validated proxy URLs
- `NINE_ROUTER_PROXY_MANAGED` — marker that we manage these vars
- `NINE_ROUTER_PROXY_URL` — last validated proxy URL
- `NINE_ROUTER_NO_PROXY` — managed noProxy value

**`applyOutboundProxyEnv(settings)`** — called on settings change, no restart required:

- If `outboundProxyEnabled` is false → clear all managed env vars
- If enabled + `outboundProxyUrl` provided → validate scheme (`http:, https:, socks5:, socks4:, socks5h:, socks4a:`) and set env vars
- If enabled + `outboundNoProxy` provided → set `NO_PROXY`/`NINE_ROUTER_NO_PROXY`
- Legacy values are cleaned up on disable

**`ensureOutboundProxyInitialized()`** — deferred `setImmediate` init on server start.

### 3.4 NoProxy Support

- `shouldBypassByNoProxy()` in `proxyFetch.js` checks `NO_PROXY`/`no_proxy` env var
- Pattern matching: `*` matches all, `.example.com` matches hostname and subdomains, exact match, bare hostname
- Integrated into `proxyAwareFetch()` → MITM DNS bypass path

---

## 4. Connection Pooling and Keep-Alive

### 4.1 Undici ProxyAgent Dispatch Cache

`proxyFetch.js` maintains a `proxyDispatchers` Map:

- Key: `${normalizedProxyUrl}::${secure?"insecure":"secure"}`
- Max size: `MEMORY_CONFIG.proxyDispatchersMaxSize` (evicts oldest entry)
- Creates `ProxyAgent` (with proxy URI) or `Agent` (direct connect) on first use
- Reuses dispatcher for subsequent requests to same proxy

**Lifetime:** In-memory, resets on process restart. No persistent connection pooling across restarts.

### 4.2 Direct Connection (No Proxy)

When no proxy is configured, `originalFetch` is used with no dispatcher, or a direct `net.Socket` HTTPS bypass (`createBypassRequest`) for MITM DNS-resolved hosts.

**Keep-Alive:** Undici `Agent` default keeps connections alive per-host. No explicit keep-alive configuration beyond undici defaults.

### 4.3 Proxy Pool Rotation

`connectionProxy.js` provides `pickProxyPoolId()`:

- **round-robin:** cycles sequentially per provider ID (in-memory, resets on restart)
- **random:** uniform random selection
- **none/single:** returns first entry

Used by provider connections to select a proxy pool when multiple are available.

---

## 5. Network Error Handling

### 5.1 TLS Certificate Error Handling

`proxyFetch.js` defines `TLS_CERT_ERRORS` set:

```js
const TLS_CERT_ERRORS = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);
```

When `STRICT_SSL` is not true and a TLS cert error occurs, the system retries with an **insecure dispatcher** (`rejectUnauthorized: false`) — effectively bypassing cert verification for self-signed corporate/antivirus MITM certs.

### 5.2 Proxy Failure Fallback

`proxyAwareFetch()` / `fetchWithTlsFallback()`:

1. Try proxy dispatcher → if fails and `strictProxy` not enabled → fall back to direct fetch
2. If `strictProxy` is enabled → throw error (do not fall back to direct IP exposure)
3. MITM DNS bypass path: resolves real IP via Google DNS, then creates direct HTTPS socket connection

### 5.3 Proxy Strict Mode

- When `strictProxy: true` is set on a proxy pool → request must go through proxy or fail hard
- Prevents accidental direct IP exposure when proxy is misconfigured
- Controlled via proxy pool configuration in DB

### 5.4 Timeout Configuration

`runtimeConfig.js` provides:

- `FETCH_CONNECT_TIMEOUT_MS: 60000` — 60s connect timeout
- `STREAM_STALL_TIMEOUT_MS: 360000` — 6min stream stall timeout
- Retry config: 429→0 attempts, 502→3@3s, 503→2@2s, 504→2@3s

---

## 6. DNS Resolution Strategy

### 6.1 Google DNS Bypass (MITM Protection)

`proxyFetch.js` resolves hostnames via Google DNS (`8.8.8.8`, `8.8.4.4`) to bypass system DNS:

```js
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;
  const dns = await import("dns");
  const { promisify } = await import("util");
  const resolver = new dns.Resolver();
  resolver.setServers(GOOGLE_DNS_SERVERS);
  const resolve4 = promisify(resolver.resolve4.bind(resolver));
  const addresses = await resolve4(hostname);
  DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
  return addresses[0];
}
```

**Cache:** `Map` keyed by hostname, TTL from `MEMORY_CONFIG.dnsCacheTtlMs`.

**Purpose:** Avoids `/etc/hosts` MITM spoofing — the proxy may intercept DNS, so we resolve via trusted Google DNS instead. Only used for hosts in `MITM_BYPASS_HOSTS` (public-CA-issued targets like `google.com`, `github.com`, `aws.com`, `cursor.sh`).

### 6.2 System DNS (Default)

When no MITM bypass is needed, the proxy uses the system's default DNS (via undici/ProxyAgent environment variables or direct connect).

### 6.3 Proxy DNS Behavior

- If proxy is configured → proxy resolves its own DNS (proxy's DNS, not system's)
- If MITM bypass is active → we resolve via Google DNS first, then connect directly to the real IP
- Bypass hosts are all public-CA-issued, so default TLS verification works without extra trust

---

## 7. DNS/Proxy Interaction Diagram

```
Client Request
    → Next.js app (src/app/) 
    → API route (/api/proxy-pools, /api/settings)
    → applyOutboundProxyEnv() sets process.env HTTP_PROXY/HTTPS_PROXY/ALL_PROXY
    → fetch() → proxyFetch.js patchedFetch → proxyAwareFetch
        │
        ├─ If MITM bypass host → resolveRealIP(Google DNS) → createBypassRequest(net.Socket)
        │
        ├─ If proxyUrl from pool/legacy → getDispatcher(ProxyAgent/{uri})
        │   └─ undici ProxyAgent handles TLS + connection pooling
        │
        └─ If no proxy → originalFetch (direct connect)
                
                └─ If shouldBypassMitmDns → resolveRealIP → createBypassRequest
```

---

## 8. ADR Decisions

### ADR-001: Proxy Environment Management (PROPOSED)

- **Decision:** Use `applyOutboundProxyEnv(settings)` on settings change, no server restart required
- **Rationale:** Enables dynamic proxy reconfiguration without downtime; aligns with the app's "no restart required" philosophy for settings changes
- **Consequences:**
  - ✅ On-the-fly proxy enable/disable/URL change
  - ⚠️ Must remember to clear managed env vars when disabling (prevent stale proxy leakage)
  - ⚠️ `NINE_ROUTER_PROXY_MANAGED` marker ensures we only clear our own vars

### ADR-002: Google DNS MITM Bypass (PROPOSED)

- **Decision:** Resolve hostnames via Google DNS when MITM bypass is active; connect directly to real IP
- **Rationale:** Prevents DNS spoofing when proxy may be intercepting DNS; all bypass targets have public CAs so TLS verification works
- **Consequences:**
  - ✅ Stronger DNS integrity for proxied requests
  - ⚠️ Added latency for DNS resolution (mitigated by cache with TTL)
  - ⚠️ Only applies to hosts in `MITM_BYPASS_HOSTS` list — other hosts use proxy's DNS

### ADR-003: Proxy Strict Mode (PROPOSED)

- **Decision:** `strictProxy: true` on proxy pools prevents fallback to direct connection
- **Rationale:** Prevents IP leakage when proxy is required but misconfigured; explicit opt-in tradeoff
- **Consequences:**
  - ✅ Guaranteed proxy routing when enabled
  - ⚠️ Requests fail if proxy unavailable (no silent direct fallback)
  - ⚠️ Must ensure proxy is always available or have rollback plan

---

## 9. Recommendations

### 9.1 Network Reliability Improvements

| Recommendation | Impact | Effort | Risk |
|----------------|--------|--------|------|
| Add circuit breaker per provider with consecutive failure threshold + cooldown window | High | 2-3 hours | Low |
| Persist proxy dispatcher cache to DB or localStorage across restarts | Medium | 1-2 hours | Low |
| Make `FETCH_CONNECT_TIMEOUT_MS` configurable via env vars | Medium | 30 min | Very Low |
| Add health check endpoint `/api/health` returning proxy status, pending requests, error budget | High | 1 hour | Very Low |
| Implement proxy pool usage metrics (track bytes, request count per pool) | Medium | 2-3 hours | Low |

### 9.2 Connection Management

| Recommendation | Impact | Effort | Risk |
|----------------|--------|--------|------|
| Increase undici Agent keep-alive settings (timeout, maxSockets) | Medium | 30 min | Very Low |
| Add proxy dispatcher size limit configurability via runtimeConfig | Low | 30 min | Very Low |
| Implement connection draining on proxy pool disable | Medium | 2 hours | Low |
| Add concurrent request limit per proxy to prevent single-pool overload | Medium | 2 hours | Low |

### 9.3 Proxy Configuration Best Practices

| Recommendation | Impact | Effort | Risk |
|----------------|--------|--------|------|
| Document required proxy scheme formats (http:, https:, socks5:, socks4:, socks5h:, socks4a:) | Low | 30 min | Very Low |
| Add validation for proxy URL scheme in API `POST /api/proxy-pools` | Low | 30 min | Very Low |
| Rotate proxy pools periodically to prevent single-point failures | Medium | Ongoing | Low |
| Add `strictProxy` default: false with opt-in for sensitive deployments | Low | 30 min | Very Low |
| Document MITM bypass host list and how to add entries | Low | 30 min | Very Low |
| Set `NINE_ROUTER_PROXY_MANAGED` only when we set env vars — ensure `applyOutboundProxyEnv` is the sole writer | Medium | 1 hour | Low |

### 9.4 DNS Resolution Improvements

| Recommendation | Impact | Effort | Risk |
|----------------|--------|--------|------|
| Increase `dnsCacheTtlMs` from default to 5-10 minutes for production | Medium | 30 min | Very Low |
| Add monitoring for DNS cache miss rate | Low | 1 hour | Very Low |
| Consider DNS-over-HTTPS for the MITM bypass path if connecting to untrusted networks | Low | 2 hours | Low |
| Add `resolver.setFallback` for offline/limited-network deployments | Low | 30 min | Very Low |

### 9.5 XYFlow/DnD-Kit Network Considerations

| Recommendation | Impact | Effort | Risk |
|----------------|--------|--------|------|
| Preconnect to cdnjs and unpkg for XYFlow/DnD-Kit CDN resources | Medium | 30 min | Very Low |
| Implement DnD-kit sensor cleanup on component unmount to prevent memory leaks | Low | 30 min | Very Low |
| Batch DnD-kit reorder operations — currently `handleDragEnd` uses `arrayMove` which is efficient, but verify no redundant re-renders | Low | 1 hour | Very Low |

---

## 10. Machine-Readable Summary

```json
{
  "customServer": {
    "file": "custom-server.js",
    "functions": {
      "sanitizeHeaders": "Strip x-forwarded-for, x-real-ip, x-9r-*; derive IP from TCP socket",
      "handleH2C": "Force connection:close, replay upgraded requests through HTTP/1.1 handler",
      "startTokenRefresh": "Background token refresh scheduler on server listen"
    },
    "ipStrategy": "TCP socket peer > loopback + forwarding headers; otherwise direct socket IP"
  },
  "outboundProxy": {
    "configSources": ["proxyPool", "legacyProxy", "none"],
    "poolTypes": ["http", "vercel", "cloudflare", "deno", "netlify"],
    "envVars": ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NINE_ROUTER_PROXY_MANAGED", "NINE_ROUTER_PROXY_URL", "NINE_ROUTER_NO_PROXY"],
    "management": "applyOutboundProxyEnv(settings) on settings change, no restart required",
    "strictProxy": "Opt-in: when true, fail hard on proxy failure instead of falling back to direct",
    "noProxy": "Pattern matching: * , .domain, exact hostname, bare hostname"
  },
  "connectionPooling": {
    "dispatcherCache": "proxyDispatchers Map in proxyFetch.js, LRU eviction at max size",
    "undiciAgent": "Default keep-alive; no explicit configuration beyond undici defaults",
    "pickProxyPoolId": "round-robin (per-provider in-memory state), random, or first-entry",
    "dispatcherMaxSize": "MEMORY_CONFIG.proxyDispatchersMaxSize (default: 20)",
    "ttl": "DNS cache TTL from MEMORY_CONFIG.dnsCacheTtlMs (default: 5min)"
  },
  "dnsResolution": {
    "default": "System DNS (via undici/ProxyAgent)",
    "mitmBypass": "Google DNS (8.8.8.8, 8.8.4.4) for hosts in MITM_BYPASS_HOSTS",
    "cache": "Map keyed by hostname, expiry = now + dnsCacheTtlMs",
    "bypassHosts": [
      "cloudcode-pa.googleapis.com",
      "daily-cloudcode-pa.googleapis.com",
      "api.individual.githubcopilot.com",
      "q.us-east-1.amazonaws.com",
      "codewhisperer.us-east-1.amazonaws.com",
      "api2.cursor.sh"
    ]
  },
  "errorHandling": {
    "tlsCertErrors": [
      "SELF_SIGNED_CERT_IN_CHAIN",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "CERT_HAS_EXPIRED",
      "ERR_TLS_CERT_ALTNAME_INVALID"
    ],
    "strictProxy": "Fail-hard when true; fall-back-to-direct when false/missing",
    "fallbackStrategy": "Proxy fail → direct fetch; strictProxy fail → throw error",
    "timeoutConfig": "FETCH_CONNECT_TIMEOUT_MS: 60000, STREAM_STALL_TIMEOUT_MS: 360000"
  },
  "recommendations": {
    "circuitBreaker": "Add per-provider circuit breaker with failure threshold + cooldown",
    "healthCheck": "Add /api/health endpoint with proxy status, pending requests, error budget",
    "timeoutConfigurable": "Make FETCH_CONNECT_TIMEOUT_MS configurable via env vars",
    "proxyValidation": "Validate proxy URL scheme in API; document required formats",
    "dnsCacheTtl": "Consider increasing dnsCacheTtlMs for production workloads",
    "persistDispatcherCache": "Persist proxy dispatcher cache across restarts",
    "keepAliveConfig": "Configure undici Agent with explicit timeout and maxSockets",
    "concurrentLimit": "Add concurrent request limit per proxy pool"
  }
}
```