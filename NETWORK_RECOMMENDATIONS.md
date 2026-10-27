# Network Reliability & Connection Management Recommendations
# 9router Repository

## Generated: 2026-10-19

### Priority: HIGH - Network Reliability Improvements

```json
{
  "items": [
    {
      "id": "NET-001",
      "title": "Add Circuit Breaker Per Provider",
      "description": "Implement a per-provider circuit breaker that marks a provider 'closed' after N consecutive failures (configurable threshold, default 5), with a configurable cooldown window before retry. Currently, fallback depends on accounts being marked unavailable via markAccountUnavailable, but there is no global circuit break threshold.",
      "impact": "High",
      "effort": "2-3 hours",
      "risk": "Low",
      "relatedTo": ["SRE_ADR.md", "SRE_summary.json"],
      "implementation": "Add circuit breaker state to provider connections DB table; add check before executor.execute(); reset on successful request"
    },
    {
      "id": "NET-002",
      "title": "Add Health Check Endpoint",
      "description": "Create /api/health endpoint returning: SSE handler status, pending request count, error budget remaining, active account count per provider, proxy status (enabled, type, URL). This enables monitoring and on-call triage without guessing.",
      "impact": "High",
      "effort": "1 hour",
      "risk": "Very Low",
      "relatedTo": ["SRE_ADR.md §7.2", "SRE_summary.json §5.2"],
      "implementation": "New route file src/app/api/health/route.js returning JSON status object"
    },
    {
      "id": "NET-003",
      "title": "Make Fetch Connect Timeout Configurable",
      "description": "Expose FETCH_CONNECT_TIMEOUT_MS as an env var (currently hardcoded to 60000ms/60s) so operators can adjust without code change/deploy for slow network / high-latency environments.",
      "impact": "Medium",
      "effort": "30 min",
      "risk": "Very Low",
      "relatedTo": ["SRE_ADR.md §5.4", "SRE_summary.json §4.2"],
      "implementation": "Read from process.env with fallback to 60000 in runtimeConfig.js; document in .env.example"
    },
    {
      "id": "NET-004",
      "title": "Persist Proxy Dispatcher Cache Across Restarts",
      "description": "The undici ProxyAgent dispatcher cache (proxyDispatchers Map) is in-memory and resets on process restart. Persist cached proxy configs to the local DB so subsequent requests after restart don't suffer cold-cache latency.",
      "impact": "Medium",
      "effort": "1-2 hours",
      "risk": "Low",
      "relatedTo": ["SRE_ADR.md §4.1", "SRE_summary.json §5.2"],
      "implementation": "Add proxy dispatcher state table in SQLite; populate on startup from DB; update on each use; TTL-based invalidation"
    },
    {
      "id": "NET-005",
      "title": "Add Proxy Pool Usage Metrics",
      "description": "Track per-proxy-pool: request count, byte count, consecutive failure count, last failure timestamp. Enables operators to identify underused/overused pools and make informed rotation decisions.",
      "impact": "Medium",
      "effort": "2-3 hours",
      "risk": "Low",
      "relatedTo": ["SRE_ADR.md §8.1", "SRE_summary.json §8.3"],
      "implementation": "Add usage counters to proxy_pools DB table; increment on each fetchWithTlsFallback call; expose via /api/proxy-pools?includeUsage=true"
    }
  ]
}
```

### Priority: MEDIUM - Connection Management

```json
{
  "items": [
    {
      "id": "NET-010",
      "title": "Increase Undici Agent Keep-Alive Settings",
      "description": "Configure undici Agent with explicit timeout and maxSockets settings. Currently relying on undici defaults which may not be optimal for high-concurrency AI provider requests.",
      "impact": "Medium",
      "effort": "30 min",
      "risk": "Very Low",
      "relatedTo": ["custom-server.js", "proxyFetch.js"],
      "implementation": "Create undici Agent with { timeout: 30000, keepAlive: true, keepAliveMsec: 10000, maxSockets: 50 } and use as default dispatcher when no proxy is configured"
    },
    {
      "id": "NET-011",
      "title": "Add Concurrent Request Limit Per Proxy",
      "description": "Prevent single proxy pool overload by adding a semaphore/concurrent request counter per proxy pool. Currently no limit — one busy pool could starve others.",
      "impact": "Medium",
      "effort": "2 hours",
      "risk": "Low",
      "relatedTo": ["connectionProxy.js", "outboundProxy.js"],
      "implementation": "Add concurrent request counter to proxy pool state; increment on fetch start, decrement on completion; reject/queue when limit exceeded"
    },
    {
      "id": "NET-012",
      "title": "Implement Proxy Pool Draining on Disable",
      "description": "When a proxy pool is disabled via settings, in-flight requests should complete or fail gracefully rather than abruptly switching to direct (especially when strictProxy is not set). Currently the env var clear is immediate.",
      "impact": "Medium",
      "effort": "2 hours",
      "risk": "Low",
      "relatedTo": ["outboundProxy.js", "applyOutboundProxyEnv"],
      "implementation": "Add grace period or in-flight request tracking; on proxy disable, wait for pending requests to complete or timeout before clearing env vars"
    },
    {
      "id": "NET-013",
      "title": "Make DNS Cache TTL Configurable",
      "description": "The DNS cache TTL (dnsCacheTtlMs) is currently read from MEMORY_CONFIG but may need adjustment based on network stability. Make configurable via env var.",
      "impact": "Low",
      "effort": "30 min",
      "risk": "Very Low",
      "relatedTo": ["proxyFetch.js", "runtimeConfig.js"],
      "implementation": "Read dnsCacheTtlMs from env with default; expose in .env.example; add monitoring for cache hit/miss ratio"
    }
  ]
}
```

### Priority: LOW - Proxy Configuration Best Practices

```json
{
  "items": [
    {
      "id": "NET-020",
      "title": "Document Proxy URL Scheme Formats",
      "description": "Clearly document the required proxy URL formats for each type: http://host:port, https://host:port, socks5://host:port, socks4://host:port, socks5h://host:port, socks4a://host:port. Currently validated in outboundProxy.js but not documented for operators.",
      "impact": "Low",
      "effort": "30 min",
      "risk": "Very Low",
      "relatedTo": ["outboundProxy.js", "SRE_summary.json"],
      "implementation": "Add section to README or docs/proxy.md with examples for each type"
    },
    {
      "id": "NET-021",
      "title": "Add Proxy URL Validation in API",
      "description": "The `POST /api/proxy-pools` endpoint validates proxy scheme in `outboundProxy.js` but the error message could be more descriptive. Add human-readable error for invalid schemes.",
      "impact": "Low",
      "effort": "30 min",
      "risk": "Very Low",
      "relatedTo": ["src/app/api/proxy-pools/route.js", "outboundProxy.js"],
      "implementation": "Improve validation error messages in route.js; add allowed schemes list to validation response"
    },
    {
      "id": "NET-022",
      "title": "Document MITM Bypass Host List",
      "description": "The `MITM_BYPASS_HOSTS` list in proxyFetch.js contains 6 hosts that trigger Google DNS resolution. Document why these hosts are bypassed and how to add new entries.",
      "impact": "Low",
      "effort": "30 min",
      "risk": "Very Low",
      "relatedTo": ["proxyFetch.js", "SRE_summary.json"],
      "implementation": "Add section to docs explaining: these are all public-CA-issued targets; TLS verification works without extra trust; add new hosts as needed (they must have valid public certs)"
    },
    {
      "id": "NET-023",
      "title": "Set strictProxy Default to False with Opt-In",
      "description": "Currently strictProxy is opt-in (set explicitly in DB). Consider making the default false with explicit opt-in for sensitive deployments, to prevent accidental request failures when proxy is misconfigured.",
      "impact": "Low",
      "effort": "1 hour",
      "risk": "Very Low",
      "relatedTo": ["SRE_ADR.md §8.3", "connectionProxy.js"],
      "implementation": "Ensure strictProxy defaults to false in DB schema and API; add warning in UI when strictProxy is enabled"
    },
    {
      "id": "NET-024",
      "title": "Add Proxy Rotation Scheduling",
      "description": "Implement automated proxy pool rotation on a schedule (e.g., daily/weekly) to prevent stale connections and distribute load. Currently manual via API.",
      "impact": "Low",
      "effort": "2 hours",
      "risk": "Low",
      "relatedTo": ["proxy-pools", "connectionProxy.js"],
      "implementation": "Add scheduled job (cron) that rotates round-robin index; or add auto-rotate flag on proxy pool configuration"
    }
  ]
}
```

### Priority: VERY LOW - XYFlow/DnD-Kit Network Considerations

```json
{
  "items": [
    {
      "id": "NET-030",
      "title": "Add Preconnect for XYFlow/DnD-Kit CDN",
      "description": "The application loads @xyflow/react and @dnd-kit/* from npm/CDN. Add <link rel=\"preconnect\"> to their CDN origins to reduce connection latency on first render.",
      "impact": "Low",
      "effort": "30 min",
      "risk": "Very Low",
      "relatedTo": ["web-performance-analysis.md", "next.config.mjs"],
      "implementation": "In layout.js, add: <link rel=\"preconnect\" href=\"https://cdn.jsdelivr.net\" crossorigin> and <link rel=\"preconnect\" href=\"https://unpkg.com\" crossorigin>"
    },
    {
      "id": "NET-031",
      "title": "Implement DnD-Kit Sensor Cleanup on Unmount",
      "description": "DnD-kit sensors (PointerSensor, KeyboardSensor) add event listeners. Verify they are properly cleaned up on component unmount to prevent memory leaks in long-running sessions.",
      "impact": "Low",
      "effort": "1 hour",
      "risk": "Very Low",
      "relatedTo": ["src/app/(dashboard)/dashboard/combos/page.js", "DnD-kit docs"],
      "implementation": "Use useSensors() cleanup or rely on React unmount; add console warning if sensor listeners > 10 per component"
    },
    {
      "id": "NET-032",
      "title": "Batch DnD-Kit Reorder Operations",
      "description": "The ModelItem uses useSortable with individual IDs. Verify no redundant re-renders occur during rapid drag operations; the current implementation uses CSS opacity transform which is efficient, but confirm no layout thrashing.",
      "impact": "Very Low",
      "effort": "1 hour",
      "risk": "Very Low",
      "relatedTo": ["src/app/(dashboard)/dashboard/combos/page.js", "web-performance-analysis.md"],
      "implementation": "Profile during drag operations; verify requestAnimationFrame batching; add memoization if needed"
    }
  ]
}
```
