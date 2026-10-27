# Diff-Grading & Mutation Testing System

## Overview
Advanced testing infrastructure for change validation, diff classification, and mutation testing. Ensures code changes are properly vetted and quality doesn't degrade.

---

## Diff-Grading System

### Classification A-Grade Diffs

**Definition**: Changes are safe, well-scoped, and don't break existing functionality.

**Criteria**:
- [ ] Only documentation/config files changed
- [ ] No import path modifications
- [ ] All existing tests pass without modification
- [ ] Pattern matching logic unchanged
- [ ] No new global side effects

**Examples**:
- Adding a new markdown file in `docs/`
- Updating a comment or constant value
- Adding a new test case (not modifying existing)
- Config changes (`.env.example`, workflow yaml changes that don't break)

**CI Outcome**: Pass — merge immediately

---

### Classification B-Grade Diffs

**Definition**: Documented behavioral changes that require test expectation updates but don't break abstractions.

**Criteria**:
- [ ] Test expectations need updating to match new behavior
- [ ] Change is intentional and documented
- [ ] No fundamental abstraction breakage
- [ ] Diff-grade script classifies as B
- [ ] Accompanying DoD task created for test updates

**Examples**:
- Pattern order change in `capabilities.js` (specific before generic)
- Math.min/max semantics adjustment with corresponding test updates
- Provider capability border changes
- TTS adapter behavior change with registry update

**CI Outcome**: Pass — merge with created task to update test expectations

**DoD Interaction**: B-grade changes require a DoD task in the backlog to update affected test expectations.

---

### Classification C-Grade Diffs

**Definition**: Pattern/order changes that require test expectation updates (documented in roadmap).

**Criteria**:
- [ ] Diff-grade script classifies as C
- [ ] Changes to pattern matching order
- [ ] Aggregation logic changes (Math.min/max semantics)
- [ ] Provider model mapping changes
- [ ] Import alias resolution changes

**Examples** (from audit history):
- `combo-caps-resolver.test.js`: 2 test expectations updated from `200_000` to `1_000_000`
- Vitest alias resolution fixes (5 test files with `@/` imports)
- Pattern matching behavior changes that were intentional

**CI Outcome**: Pass — merge with test expectation updates

**DoD Interaction**: C-grade changes must have corresponding updates in the Definition of Done checklist (Pattern matching logic verified item).

**Classification C Workflow**:
1. Diff-grade classifies change as C
2. Developer updates affected test expectations
3. All tests pass (`npx vitest run`)
4. DoD checklist: "Pattern matching logic verified" ✅
5. Merge approved

---

### Classification D-Grade Diffs

**Definition**: Changes that break fundamental abstractions and require architectural review.

**Criteria**:
- [ ] Diff-grade script classifies as D
- [ ] Abstraction breakage detected
- [ ] Multiple files affected in cascade
- [ ] Fundamental behavior change without documentation
- [ ] Security or data integrity at risk

**Examples**:
- Removing a core API endpoint without replacement
- Changing the provider credential selection algorithm
- Removing the mutex without replacement
- Removing API key masking
- Changing the auth guard fundamental logic

**CI Outcome**: Block — must fix before merge

**DoD Interaction**: D-grade changes fail the Security and Infrastructure DoD gates immediately.

**Classification D Workflow**:
1. Diff-grade classifies change as D
2. Architectural review required (2+ senior agents/developers)
3. Fix plan created with backward compatibility
4. Comprehensive test coverage added
5. All tests pass
6. Merge approved after review

**D-Grade Workflow Diagram**:
```
Diff → D-grade → Architectural Review → Fix Plan → Test Coverage → All Tests Pass → Review → Merge
                                                    ↘
                                              Block Merge (unless critical hotfix)
```

---

### Diff-Grading Script

**Location**: `scripts/diff-grade.mjs`

**Usage**:
```bash
# From repository root, pipe in git diff
git diff HEAD > /tmp/my-changes.diff
node scripts/diff-grade.mjs < /tmp/my-changes.diff
```

**Script Logic**:
```javascript
#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const diff = fs.readFileSync('/dev/stdin', 'utf-8');

// Parse changed files from diff
const fileChanges = diff.match(/diff --git a\/([^\s]+) b\/([^\s]+)/g) || [];

const classification = {
  grade: 'A',
  reasons: [],
  testImpact: 'none',
  actions: []
};

// Analyze each changed file
for (const change of fileChanges) {
  const [, oldPath, newPath] = change.match(/diff --git a\/([^\s]+) b\/([^\s]+)/);
  const resolvedPath = path.posix.resolve(oldPath);
  
  // Pattern matching changes → C grade
  if (resolvedPath.includes('capabilities.js') || resolvedPath.includes('combo-caps-resolver')) {
    classification.grade = 'C';
    classification.reasons.push('Pattern matching change in capabilities.js');
    classification.testImpact = 'expectations-update';
    classification.actions.push('Update test expectations for new pattern behavior');
  }
  
  // Test file changes → assess impact
  if (resolvedPath.includes('tests/')) {
    if (resolvedPath.includes('dashboard-guard') || resolvedPath.includes('key-access')) {
      classification.testImpact = 'security-critical';
      if (classification.grade === 'A') classification.grade = 'B';
    }
    if (resolvedPath.includes('combo-caps-resolver')) {
      if (classification.grade !== 'C') classification.grade = 'C';
    }
  }
  
  // Import alias changes → B or C grade
  if (resolvedPath.includes('vitest.config') || resolvedPath.match(/\.test\.(js|mjs)$/)) {
    if (resolvedPath.includes('bedrock-provider-api-secrets') || 
        resolvedPath.includes('force-stream-config') || 
        resolvedPath.includes('db-migration-chain')) {
      if (classification.grade === 'A') classification.grade = 'B';
      if (classification.grade === 'C') classification.grade stays 'C';
      classification.reasons.push('Import path alias resolution test affected');
    }
  }
  
  // Security-related changes → minimum B grade
  if (resolvedPath.includes('dashboardGuard') || resolvedPath.includes('api/keys') || 
      resolvedPath.includes('auth') || resolvedPath.includes('ssrf')) {
    if (classification.grade === 'A') classification.grade = 'B';
    if (classification.grade === 'D') /* stays D */;
  }
}

// Output result
const output = `
Diff Grade: ${classification.grade}

Reasons:
${classification.reasons.map(r => `- ${r}`).join('\n')}

Test Impact: ${classification.testImpact}

Recommended Actions:
${classification.actions.map(a => `- ${a}`).join('\n')}

`;
process.stdout.write(output);
```

**Expected Output Examples**:

**A-Grade Diff**:
```
Diff Grade: A

Reasons:
- Only documentation/config changes

Test Impact: none

Recommended Actions:
- None needed
```

**B-Grade Diff** (import alias fix):
```
Diff Grade: B

Reasons:
- Import path alias resolution test affected

Test Impact: expectations-update

Recommended Actions:
- Update test imports from @/ to relative paths
- Run npx vitest run to verify all tests pass
```

**C-Grade Diff** (pattern change):
```
Diff Grade: C

Reasons:
- Pattern matching change in capabilities.js
- Import path alias resolution test affected

Test Impact: expectations-update

Recommended Actions:
- Update test expectations for new pattern behavior
- Verify Math.min/max logic is intentional
- Run npx vitest run to confirm all tests pass
```

**D-Grade Diff** (security change):
```
Diff Grade: D

Reasons:
- Security-related change affecting /api/keys or auth

Test Impact: blocking

Recommended Actions:
- Architectural review required
- Create fix plan with backward compatibility
- Add comprehensive test coverage
- Block merge until review complete
```

---

## Mutation Testing System

### Purpose
Mutation testing validates that test suite can detect intentional code modifications (mutants). High mutation score = good test coverage of logic.

### Mutation Testing Tool: `vitest-mutate`

**Installation**:
```bash
cd /c/9router-forked/fork
npm install -D vitest-mutate
```

**Configuration** (`vitest.config.mjs` or add to `vitest.config.js`):
```javascript
import { defineConfig } from 'vitest/config';
import { mutate } from 'vitest-mutate';

export default defineConfig({
  // ... existing config
  mutate: {
    killTimeout: 10000,  // timeout per mutant in ms
    maxMutants: 100,     // max mutants to generate per run
    timeout: 120000,     // total test run timeout in ms
    coverage: true,      // track mutation coverage alongside test coverage
    reporters: ['default', '-summary', 'html'],  // HTML report output
  },
});
```

### Mutation Rules (Custom)

**Rule 1: Math.min → Math.max in combo caps**
- **Target**: `open-sse/providers/capabilities.js` `aggregateComboCapabilities` function
- **Mutation**: Replace `Math.min(contextWindows)` with `Math.max(contextWindows)`
- **Expected**: Tests should fail (expectations updated from 200k to 1M already, but original test had wrong expectation)
- **Mutation Score**: Should be detected (high priority rule)

**Rule 2: API key masking removal**
- **Target**: `src/app/api/keys/route.js` - masking logic removal
- **Mutation**: Remove the `apiKeyMasked()` call or replace with raw key output
- **Expected**: Security tests (dashboard-guard, key-access) should fail
- **Mutation Score**: Critical path - must be 100% killed

**Rule 3: Loopback check removal**
- **Target**: `src/dashboardGuard.js` `isAuthenticated()` function
- **Mutation**: Remove `isLocalRequest()` check, make always return true
- **Expected**: dashboard-guard tests should fail (24/24 must still pass)
- **Mutation Score**: Must kill all mutants in auth path

**Rule 4: `requireLogin=false` scope removal**
- **Target**: `src/dashboardGuard.js` - `requireLogin` global bypass
- **Mutation**: Make `requireLogin` have no effect, always skip auth
- **Expected**: key-access tests should fail (27/27 must still pass)
- **Mutation Score**: Must kill all mutants in auth scoping

**Rule 5: SSRF guard removal**
- **Target**: `open-sse/executors/base.js` SSRF validation
- **Mutation**: Remove `assertPublicUrlResolved()` call
- **Expected**: SSRF-related tests should fail
- **Mutation Score**: Must detect the security regression

### Mutation Testing Workflow

**Step 1: Run Mutation Tests**
```bash
cd /c/9router-forked/fork
npm run test:mutate  # or: npx vitest run --mutate
```

**Step 2: Review Results**
- **Mutation Score**: Percentage of mutants killed by tests
  - **Target**: > 80% on critical paths
  - **Acceptable**: > 60% overall
  - **Concern**: < 60% → tests may not cover critical logic

- **Surviving Mutants**: Review each
  - Some may be "equivalent mutants" (tests already wrong)
  - Some may indicate missing test coverage
  - Some may be false positives (mutation out of scope)

- **Mutation Coverage Report**: 
  - HTML report generated in `mutate-report/`
  - View: `open mutate-report/index.html`

**Step 3: Fix Surviving Mutants**
For each surviving mutant:
1. Determine if it's a real issue or equivalent mutant
2. If real: add or improve test coverage
3. If equivalent: document why test already covers the logic
4. If false positive: adjust mutation rule scope

**Step 4: Re-run Mutation Tests**
```bash
npm run test:mutate  # re-run to verify fixes
```

**Step 5: CI Integration**
Add to GitHub Actions:
```yaml
- name: 🧪 Run Mutation Tests
  run: npm run test:mutate
  # Fail on mutation score < 80%
  # artifact: mutate-report/ for download
```

### Mutation Testing Integration Checklist

- [ ] `npm run test:mutate` runs without errors
- [ ] Mutation score > 80% on critical paths
- [ ] All 5 custom rules execute (Math.min→max, API key masking, loopback check, requireLogin scope, SSRF guard)
- [ ] Surviving mutants reviewed and documented
- [ ] HTML report generated and uploaded as artifact
- [ ] CI fails if mutation score < 80%
- [ ] Mutation testing included in PR validation

### Mutation Testing Rules Catalog

| Rule ID | Target | Mutation | Expected Test Result | Priority |
|---|---|---|---|---|
| M-01 | `aggregateComboCapabilities` | `Math.min()` → `Math.max()` | Tests fail (expectations updated) | Critical |
| M-02 | `apiKeysRoute` | masking removed | Security tests fail | Critical |
| M-03 | `isAuthenticated()` | loopback check removed | dashboard-guard tests fail | Critical |
| M-04 | `requireLogin` handling | scope removed | key-access tests fail | Critical |
| M-05 | SSRF guard | validation removed | SSRF tests fail | Critical |
| M-06 | `getProviderCredentials` | mutex disabled | concurrency tests detect issue | High |
| M-07 | `synthesizeViaConfig` | import removed | TTS integration tests fail | High |
| M-08 | `handleTtsCore` | adapter dispatch removed | TTS unit tests fail | High |
| M-09 | `pruneUsageHistory()` | no-op | Usage history grows unbounded | Medium |
| M-10 | `getSettings()` | cache disabled | Performance tests detect regression | Medium |

### Equivalent Mutant Detection

**Definition**: A mutant that no test can kill, even though the code change is meaningful. This indicates:

1. **Tests are wrong** (they were written to match the buggy behavior)
2. **Tests don't cover the changed code** (gap in test coverage)
3. **Mutation is out of scope** (not relevant to tested code)

**Resolution Strategy**:
1. Review the mutant: "Does this code change matter?"
2. Check the test: "Does this test cover this logic?"
3. If test is wrong: fix the test, not the mutant
4. If test missing: add test coverage
5. If out of scope: document and remove from rule catalog

**Equivalent Mutant Log** (example format):
```
Rule M-01: Math.min → Math.max in aggregateComboCapabilities
Status: EQUIVALENT MUTANT
Reason: Existing test expectations already expect 1_000_000 (updated in PR #20)
Action: Document as equivalent; no test change needed
```

---
*Mutation testing system last updated: 2026-10-27*
*Current version: 1.0*
*Critical path mutation score target: > 80%*
*Overall mutation score target: > 60%*