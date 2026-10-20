# 9router Project Management ADR

**Date**: Mon Oct 19 2026  
**Status**: Investigation Complete - Ready for Prioritized Work

## 1. Project Status and Roadmap

### Current State Summary
- **Framework**: Next.js 16 app (v0.5.104) with CLI and open-sse packages
- **Testing**: Vitest v5.0.5 with ~300+ unit tests
- **Dependencies**: 621 npm packages installed

### ✅ Completed Work
| Category | Item | Status |
|----------|------|--------|
| Pattern Matching | combo-caps-resolver.test.js expectations updated (200k→1M) | ✅ Complete |
| Documentation | FINAL_SUMMARY.md, FIX_SUMMARY.md, FIX_PLAN.md | ✅ Complete |
| Web Perf Analysis | web-performance-analysis.md | ✅ Complete |
| Drift Prevention | 4-point checklist created (STATUS_UPDATE.md) | ✅ Complete |

### ⚠️ Active Issues

#### A. Vitest Config Import Path Alias Resolution
- **Affected test files** (5 files, ~15 import instances):
  - `tests/unit/bedrock-provider-api-secrets.test.js` - `@/app/api/providers/route.js`, `@/app/api/providers/[id]/route.js`, `@/models/index.js`
  - `tests/unit/force-stream-config.test.js` - `@/lib/dataDir.js`
  - `tests/unit/db-migration-chain.test.js` - `@/lib/db/driver.js`
- **Root cause**: Vitest alias `{find: /^@\//, replacement: resolve(__dirname, "../src") + "/"}` not resolving properly depending on test execution directory
- **Risk**: Medium - blocks test execution for affected files

#### B. MiniMax TTS Test Expectations
- **Affected file**: `tests/unit/minimax-tts.test.js` - 3 test expectations
- **Root cause**: Tests expect `result.success = false` but code now returns `true` because:
  - Minimax provider IS configured in registry (`open-sse/providers/registry/minimax.js` line 73: `ttsConfig: { baseUrl: "https://api.minimax.io/v1/t2a_v2", authType: "apikey", authHeader: "bearer", format: "minimax-tts" }`)
  - `FORMAT_HANDLERS["minimax-tts"]` dispatches to `minimaxTts()` function
  - Mock fetch + hex-to-base64 conversion works correctly
  - `createTtsResponse()` returns `{ success: true, response: ... }`
- **Risk**: Low - test expectations need updating to match actual working code

#### C. Web Performance Improvements (Nice-to-Have)
- **Key areas**: Preconnect fonts.gstatic.com, reduce font loading timeout, Tailwind v4 purge, focus-visible styles
- **Impact**: +100-300ms FCP/LCP improvement
- **Effort**: 5-30 minutes per fix
- **Priority**: Post-test-fix improvements

### Next Prioritized Items
1. Fix vitest config alias resolution (immediate - enables test execution)
2. Update minimax-tts test expectations (immediate - enables test passing)
3. Run full test suite to verify all fixes
4. Apply top 3 web performance fixes (short-term)

### Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Test suite partially blocked | High (5 files) | Medium | Fix vitest config or convert imports to relative paths |
| Test expectations incorrect | Medium (3 tests) | Low | Update expectations to match working code |
| Pattern matching regression | Low | High | Enforce 4-point drift prevention checklist |
| Scope creep on performance fixes | Low | Medium | Stick to high-impact/low-effort items only |

## 2. Code Quality Assessment

### Technical Debt Inventory

| Debt Area | File(s) | Description | Effort to Fix |
|-----------|---------|-------------|---------------|
| Import alias resolution | `tests/vitest.config.js`, 5 test files | `@/...` aliases not resolving consistently | 30 min (fix config) or 1-2 hrs (convert imports) |
| Test expectation drift | `tests/unit/minimax-tts.test.js` | 3 tests expect `success: false` but code returns `true` | 15 min (update expectations) |
| Pattern order documentation | `open-sse/providers/capabilities.js` | PATTERN_CAPABILITIES order critical, not documented | 15 min (add comments) |
| TTS provider config | `open-sse/handlers/ttsProviders/minimax.js` | Works correctly but tests outdated | 0 min (already working) |

### Areas Needing Refactoring
1. **Vitest configuration** - alias system is fragile; consider making it more robust or documenting required execution directory
2. **Test expectations** - 3 minimax-tts tests have incorrect expectations; need updating
3. **Pattern matching comments** - PATTERN_CAPABILITIES order is critical but not well-documented

### Pattern Consistency Issues
- **PATTERN_CAPABILITIES ordering** in `capabilities.js`: Specific patterns must come before generic (e.g., `*glm-5.3*` before `*glm-5*`). This is enforced by "first match wins" logic.
- **Provider override short-circuiting**: PROVIDER_CAPABILITIES short-circuits before pattern matching. This is intentional but not well-documented.
- **Math.min/max semantics**: `aggregateComboCapabilities` takes min of contextWindow, max of maxOutput. Tests now correctly expect 1M for contextWindow.

### Documentation Gaps
1. **Vitest alias troubleshooting** - No documentation on why aliases fail from certain directories
2. **TTS provider flow** - How minimax TTS works end-to-end not clearly documented
3. **Drift prevention checklist** - Created but not enforced in CI/CD

## 3. Project Management ADR

### Priority Ordering of Remaining Work Items

```mermaid
priority order
    title 9router Remaining Work Priorities
    axis x Low Effort --> High Effort
    axis y Low Impact --> High Impact

    pattern_fixing --> vitest_alias_fix
    test_expectation_update --> vitest_alias_fix
    full_test_suite --> vitest_alias_fix
    perf_improvements --> test_suite_passing
```

**Priority 1 (This Sprint)**: Fix vitest config alias resolution
- **Why**: Enables 5 test files to run
- **Options**:
  - A: Ensure vitest runs from `C:\9router\tests` directory (1 min change)
  - B: Update test imports to use relative paths instead of `@/` (1-2 hrs)
  - C: Fix vitest config `__dirname` resolution (30 min)

**Priority 2 (This Sprint)**: Update minimax-tts test expectations
- **Why**: Tests expect `success: false` but code correctly returns `true`
- **Fix**: Change `expect(result.success).toBe(false)` to `expect(result.success).toBe(true)` on lines 35, 91

**Priority 3 (Next Sprint)**: Run full test suite and document remaining failures
- **Why**: Verify all fixes work together
- **Deliverable**: Baseline test results document

**Priority 4 (Optional)**: Apply web performance improvements
- **Why**: Nice-to-have, +100-300ms perf improvement
- **Timeline**: After test suite passes

### Risk Mitigation Strategies

| Risk | Mitigation |
|------|------------|
| Vitest aliases break after code changes | Enforce 4-point checklist (run vitest, verify imports, check pattern order, verify Math.min/max) |
| Test expectations drift again | Add test expectations to drift detection baseline |
| Pattern matching order changes | Document PATTERN_CAPABILITIES ordering rules; enforce review on any pattern changes |
| TTS provider config changes | Test minimax TTS with real API key in staging; don't change test mocks to hide real issues |

### Definition of Done for Each Category

| Category | Definition of Done |
|----------|-------------------|
| **Vitest Alias Fix** | - `npx vitest run` completes without "Cannot find package" errors for all 5 affected test files<br>- All `@/...` imports resolve correctly in test environment |
| **MiniMax TTS Tests** | - All 3 test expectations match actual `handleTtsCore` behavior<br>- `expect(result.success)` matches actual return value (true)<br>- Hex audio conversion produces expected base64 output |
| **Full Test Suite** | - `npx vitest run` completes with 0 unexpected failures (known failures documented)<br>- Drift prevention baseline recorded |
| **Web Performance** | - Preconnect added to layout.js for fonts.gstatic.com<br>- Font loading timeout reduced from 3s to 1s<br>- Tailwind v4 purge verified (or fallback to v3 config)<br>- Focus-visible styles added to globals.css |

### Drift Prevention Governance Process

#### 4-Point Checklist (Mandatory for Every AI Change)
```
1. ✅ Run `npx vitest run` on affected test file(s) - record baseline
2. ✅ Verify all imports resolve (try import path in test environment)
3. ✅ Check if change affects pattern matching order (capabilities.js)
4. ✅ Verify Math.min/max logic is intentional (combo caps aggregation)
```

#### Drift Detection Commands
```bash
# 1. Baseline test results
cd C:\9router
npx vitest run > baseline.txt 2>&1

# 2. After changes - compare
npx vitest run > new.txt 2>&1

# 3. Diff failures
diff baseline.txt new.txt | grep -E '✓|×|FAIL|passed' > drift-report.txt

# 4. Import resolution test
cd C:\9router\tests && npx vitest run single-test.test.js 2>&1 | tail -5
```

#### 9router-Specific Patterns to Watch
| Area | AI Must Check | Risk if Wrong |
|------|--------------|---------------|
| `open-sse/providers/capabilities.js` PATTERN order | Specific before generic | Wrong model capabilities resolved |
| `aggregateComboCapabilities` Math.min/max | Min for contextWindow, max for maxOutput | Incorrect combo limits |
| `getCapabilitiesForModel` provider stripping | Always strips `/provider/` prefix | Wrong capabilities for provider-scoped models |
| `tests/vitest.config.js` alias `/^@\//` | Must resolve to `../src` | "Cannot find package" import errors |
| Provider capability overrides | Short-circuit before pattern matching | Provider limits ignored |

#### Governance Enforcement
- **Pre-commit**: Run 4-point checklist on changed files
- **CI/CD**: Add vitest run as gate on pull requests
- **Monthly**: Review drift-report.txt for systematic issues
- **Quarterly**: Full test suite run + performance audit

## 4. Recommendations

### Sprint Planning

**Sprint 1 (This Week - Priority 1-2)**:
- **Goal**: Enable test suite execution and verify core fixes
- **Tasks**:
  1. Fix vitest config alias resolution (choose: run from tests dir OR convert imports)
  2. Update minimax-tts test expectations (3 assertions)
  3. Run `npx vitest run` and document results
- **Success criteria**: Test suite runs without "Cannot find package" errors; 2 of 3 minimax TTS tests pass

**Sprint 2 (Next Week - Priority 3)**:
- **Goal**: Full test suite pass and baseline establishment
- **Tasks**:
  1. Run full `npx vitest run`, document any remaining failures
  2. Create test baseline baseline.txt
  3. Address any new failures from baseline comparison

**Sprint 3 (Optional - Priority 4)**:
- **Goal**: Web performance improvements
- **Tasks**:
  1. Add preconnect to fonts.gstatic.com in layout.js
  2. Reduce font loading timeout from 3s to 1s
  3. Verify Tailwind v4 purge configuration
  4. Add focus-visible styles to globals.css

### Technical Debt Paydown Schedule

| Debt Item | Owner | Timeline | Effort | Dependencies |
|-----------|-------|----------|--------|--------------|
| Vitest alias fix | PM/Dev | This sprint | 30 min | None |
| MiniMax TTS test update | PM/Dev | This sprint | 15 min | Vitest fix (run tests) |
| Full test suite baseline | PM | Next sprint | 1 hr | Both above done |
| Pattern order documentation | Dev | Next sprint | 15 min | None |
| Drift prevention CI check | PM | Next sprint | 30 min | Baseline established |

### Code Review Guidelines

**Required Checks for Every PR**:
1. [ ] Run `npx vitest run` on affected test files - no new failures
2. [ ] Verify all imports resolve in test environment
3. [ ] If changing `capabilities.js` PATTERN_CAPABILITIES: check pattern order implications
4. [ ] If changing `aggregateComboCapabilities`: verify Math.min/max semantics preserved
5. [ ] Check drift-prevention 4-point checklist applied

**Automated Gates** (CI/CD):
- `npx vitest run` must pass (or show only documented known failures)
- Drift report must not show systematic new failures
- Pattern order in capabilities.js must be reviewed on any change

### Onboarding New Developers

**Key Concepts to Explain**:
1. **PATTERN_CAPABILITIES ordering**: First match wins; specific patterns must come before generic
2. **Provider override short-circuiting**: PROVIDER_CAPABILITIES wins over patterns; this is intentional
3. **Math.min/max semantics**: contextWindow takes min across models; maxOutput takes max
4. **Vitest alias system**: `@/` resolves to `../src/` but only when running from `tests/` directory; otherwise use relative paths
5. **Drift prevention**: 4-point checklist must be followed on every change

**First Tasks for New Developer**:
1. Run `npx vitest run` from `C:\9router\tests` - verify it works
2. Read `FIX_SUMMARY.md` and `FINAL_SUMMARY.md` to understand investigation history
3. Fix one of the 5 affected test import paths to understand the alias issue
4. Update the minimax-tts test expectations to see the TTS flow in action

**Repository Context**:
- 1,797 files, 621 npm packages
- Core packages: `open-sse` (SSE engine), `src/shared/constants/providers` (provider definitions)
- Testing: Vitest v5.0.5 with ~300+ unit tests
- Pattern matching is the most critical logic - changes here affect model capabilities globally

---
*This ADR replaces all previous informal task lists and should be referenced for all future 9router project management decisions.*