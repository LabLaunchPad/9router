#!/usr/bin/env node
/**
 * Diff-Grading Script
 * 
 * Analyzes git diffs and classifies them as A/B/C/D grade.
 * 
 * Usage: node scripts/diff-grade.mjs < <(git diff HEAD)
 *      or: git diff HEAD | node scripts/diff-grade.mjs
 * 
 * Output includes: grade, reasons, test impact, recommended actions.
 */

import fs from 'fs';
import path from 'path';

// Read diff from stdin
let diff = '';
process.stdin.on('data', chunk => { diff += chunk; });
process.stdin.on('end', () => {
  const classification = {
    grade: 'A',
    reasons: [],
    testImpact: 'none',
    actions: []
  };

  // Parse changed files from diff
  const fileChanges = diff.match(/diff --git a\/([^\s]+) b\/([^\s]+)/g) || [];

  for (const change of fileChanges) {
    const match = change.match(/diff --git a\/([^\s]+) b\/([^\s]+)/);
    if (!match) continue;
    const oldPath = match[1];
    const newPath = match[2];
    const resolvedPath = path.posix.resolve(oldPath);

    // Pattern matching changes → C grade
    if (resolvedPath.includes('capabilities.js') || resolvedPath.includes('combo-caps-resolver')) {
      if (classification.grade !== 'C' && classification.grade !== 'D') {
        classification.grade = 'C';
      }
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
        if (classification.grade === 'C') /* stays C */;
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

`.trim();

  process.stdout.write(output);
});