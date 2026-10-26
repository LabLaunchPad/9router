## 2025-05-18 - Type Confusion and Unhandled Exception Bypass on Login Endpoint
**Vulnerability:** Sending non-string payloads (e.g. `{ "password": 123 }`) or malformed JSON to `POST /api/auth/login` caused `bcrypt.compare` to throw an unhandled `TypeError`, returning 500 internal server errors, leaking error details, and bypassing failure rate-limiting (`recordFail`).
**Learning:** Functions that consume external JSON input must validate parameter types before passing them to cryptographic or comparison libraries. Relying on top-level `catch` blocks can inadvertently bypass rate limiting or security middleware logic executed later in the handler.
**Prevention:** Always validate `typeof input === "string"` before calling `bcrypt.compare` or hashing functions, and ensure invalid/malformed payloads fail open into rate-limiting handlers with proper 4xx status codes.

## 2026-03-31 - Route Handler SSRF Guard DNS Resolution Bypass
**Vulnerability:** Synchronous `assertPublicUrl` check in route handlers (`/api/provider-nodes/validate`, `/api/cli-tools/cowork-mcp-tools`, `/api/providers/validate`) checked literal hostnames without DNS resolution, allowing wildcard DNS domains (e.g., `127.0.0.1.nip.io` or `127.0.0.1.sslip.io`) to bypass SSRF guards and trigger server-side HTTP requests to internal/loopback targets.
**Learning:** `assertPublicUrl` only checks literal strings and IP patterns. Whenever a route handler performs an asynchronous outbound `fetch()` based on client or node input, `await assertPublicUrlResolved(url)` or `fetchPublic(url)` must be used to ensure hostnames resolving to private/loopback IPs are blocked before the HTTP request is dispatched.
**Prevention:** Route handlers accepting target URLs or validating provider nodes must always invoke `await assertPublicUrlResolved(url)` for remote requests rather than synchronous literal string checks.

# Sentinel Journal
