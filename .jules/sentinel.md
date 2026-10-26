# Sentinel Journal

## 2026-03-31 - Route Handler SSRF Guard DNS Resolution Bypass

**Vulnerability:** Synchronous `assertPublicUrl` check in route handlers (`/api/provider-nodes/validate`, `/api/cli-tools/cowork-mcp-tools`, `/api/providers/validate`) checked literal hostnames without DNS resolution, allowing wildcard DNS domains (e.g., `127.0.0.1.nip.io` or `127.0.0.1.sslip.io`) to bypass SSRF guards and trigger server-side HTTP requests to internal/loopback targets.

**Learning:** `assertPublicUrl` only checks literal strings and IP patterns. Whenever a route handler performs an asynchronous outbound `fetch()` based on client or node input, `await assertPublicUrlResolved(url)` or `fetchPublic(url)` must be used to ensure hostnames resolving to private/loopback IPs are blocked before the HTTP request is dispatched.

**Prevention:** Route handlers accepting target URLs or validating provider nodes must always invoke `await assertPublicUrlResolved(url)` for remote requests rather than synchronous literal string checks.
