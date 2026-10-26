# Performance & Audit Verification Results

## Before vs. After Summary

| Benchmark / Area | Before Changes | After Changes | Status | Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Next.js Production Build (`npm run build`)** | 60.0s compile time, static gen 3.0s | 30.4s compile time, static gen 1.3s | ⚡ 49% Faster Compile | Bundle dynamic loading improvements reduced build work |
| **Parallel Usage Writes (`saveRequestUsage`)** | 2 / 100 requests recorded (98 dropped) | 100 / 100 requests recorded (0 dropped) | ✅ 100% Accuracy | Fixed timestamp collision in SQLite usage repo dedup check |
| **Mid-Stream Failure Error Budget** | Uncounted (0% error budget impact) | Counted in `sse_error_responses_total` | ✅ Correct Attribution | `recordStreamFailure` wired into stream controller error handling |
| **Chaos Test Suite (`npm run test:chaos`)** | 25 passed / 0 failed | 25 passed / 0 failed | ✅ 100% Pass | Zero regressions across kill-switch, timeout, & failover tests |
| **Targeted Unit Tests (`sse-metrics`, `db-concurrent`, `windsurf-executor`)** | 3 test suite failures | 68 passed / 0 failed | ✅ 100% Pass | Fixed pre-existing concurrency and registry test mismatches |
| **Docker Compose Security & Build Context** | Missing `build: .`, Headroom port `0.0.0.0:8787` | `build: .` added, Headroom `127.0.0.1:8787` | 🔒 Secured | Docker deployment now builds local tree and isolates internal ports |

---

## Files Changed

1. `open-sse/handlers/chatCore.js`: Wired `recordStreamFailure` into `streamController.onError`.
2. `src/sse/services/metrics.js`: Added `recordStreamFailure` helper to track post-200 stream errors in Prometheus metrics.
3. `src/lib/db/repos/usageRepo.js`: Added `generateUniqueTimestamp()` with microsecond sequence tracking to prevent dropped concurrent writes.
4. `src/app/(dashboard)/dashboard/combos/ComboFormModal.js` & `page.js`: Extracted `@dnd-kit` modal into a lazy-loaded dynamic component.
5. `src/app/(dashboard)/dashboard/pxpipe/PxpipeAreaChart.js` & `PxpipeClient.js`: Extracted `recharts` widget into a lazy-loaded dynamic component.
6. `docker-compose.yml`: Added `build: .` to `9router` service and bound Headroom to `127.0.0.1:8787:8787`.
7. `.gitignore`: Added `!docs/performance/**` exception rule to track audit reports in git repository.
8. `tests/unit/windsurf-executor.test.js` & `tests/unit/sse-metrics.test.js`: Fixed test assertions and added tests for `recordStreamFailure`.
9. `docs/performance/BASELINE.md`, `AUDIT.md`, `RESULTS.md`: Audit reports and evidence records.
