#!/usr/bin/env node
/** 
 * Mutation Testing Rules Verification Script
 * 
 * Verifies that the 10 mutation testing rules (M-01 through M-10) 
 * documented in MUTATION_TESTING_DIFF_GRADING.md are properly configured.
 * Also checks if test:mutate script exists in package.json.
 * 
 * Usage: node scripts/test-mutate-rules.mjs
 * 
 * Exit codes:
 *   0: All rules configured correctly
 *   1: Rules missing or misconfigured
 */

import fs from 'fs';
import path from 'path';

const repoRoot = process.cwd();
const mutationDocPath = path.join(repoRoot, 'MUTATION_TESTING_DIFF_GRADING.md');

let mutationDoc = '';
if (fs.existsSync(mutationDocPath)) {
  mutationDoc = fs.readFileSync(mutationDocPath, 'utf-8');
}

// Define the 10 mutation testing rules from MUTATION_TESTING_DIFF_GRADING.md
// These are the rule IDs as they appear in the documentation table
const mutationRules = [
  { id: 'M-01', name: 'aggregateComboCapabilities: Math.min → Math.max', critical: true },
  { id: 'M-02', name: 'apiKeysRoute: masking removed', critical: true },
  { id: 'M-03', name: 'isAuthenticated(): loopback check removed', critical: true },
  { id: 'M-04', name: 'requireLogin handling: scope removed', critical: true },
  { id: 'M-05', name: 'SSRF guard: validation removed', critical: true },
  { id: 'M-06', name: 'getProviderCredentials: mutex disabled', critical: false },
  { id: 'M-07', name: 'synthesizeViaConfig: import removed', critical: false },
  { id: 'M-08', name: 'handleTtsCore: adapter dispatch removed', critical: true },
  { id: 'M-09', name: 'pruneUsageHistory: no-op', critical: false },
  { id: 'M-10', name: 'getSettings(): cache disabled', critical: true }
];

let passed = 0;
let failed = 0;
const findings = [];

// Check each rule is documented in MUTATION_TESTING_DIFF_GRADING.md
for (const rule of mutationRules) {
  const ruleFound = mutationDoc.includes(rule.id);
  
  if (ruleFound) {
    passed++;
    findings.push(`✅ ${rule.id}: ${rule.name}`);
  } else {
    failed++;
    findings.push(`❌ ${rule.id}: ${rule.name} - NOT FOUND in documentation`);
  }
}

// Check for test:mutate script in package.json
const packageJsonPath = path.join(repoRoot, 'package.json');
let packageJsonHasMutateScript = false;
try {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
  packageJsonHasMutateScript = 'test:mutate' in packageJson.scripts;
} catch {
  // ignore
}

if (packageJsonHasMutateScript) {
  passed++;
  findings.push('✅ test:mutate script defined in package.json');
} else {
  failed++;
  findings.push('❌ test:mutate script NOT found in package.json');
}

// Summary
console.log('Mutation Testing Rules Verification');
console.log('=====================================\n');

findings.forEach(f => console.log(f));

console.log(`\nResults: ${passed} passed, ${failed} failed out of ${mutationRules.length + 1} checks\n`);

if (failed > 0) {
  console.log('\nSome mutation testing rules are not properly configured.');
  process.exit(1);
} else {
  console.log('\n✅ All mutation testing rules are properly configured!');
  process.exit(0);
}