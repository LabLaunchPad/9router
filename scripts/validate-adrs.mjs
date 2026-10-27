#!/usr/bin/env node
/** 
 * ADR Validation Script 
 * 
 * Validates all ADR markdown files have required metadata fields. 
 * CI integration: fails job if any ADR is missing Status, last-reviewed, 
 * or has invalid JSON artifacts. 
 * 
 * Usage: node scripts/validate-adrs.mjs 
 * (Must be run from the repository root, i.e. /c/9router-forked/fork) 
 * 
 * Failure Output (example): 
 *   ❌ ADR_FILE.md: Missing Status field 
 *   ❌ ADR_FILE.md: Invalid last-reviewed date format: "not-a-date" 
 *   ❌ adjacent-file.json: Invalid JSON - unexpected token at line 1 column 1 
 *   ✅ All ADRs valid 
 */ 
 
import fs from 'fs'; 
import path from 'path'; 

// Resolve ADR directory from repository root 
const adrDir = path.resolve(process.cwd(), 'docs', 'repo-audit'); 
const adrFiles = fs.readdirSync(adrDir).filter(f => f.endsWith('.md')); 

let issues = 0; 
let checked = 0; 
const issueDetails = []; 

for (const file of adrFiles) { 
  const filePath = path.join(adrDir, file); 
  const content = fs.readFileSync(filePath, 'utf-8'); 
  checked++; 
 
  // Check for Status field 
  const statusMatch = content.match(/^Status:\s*([A-Za-z]+)/m); 
  if (!statusMatch) { 
    issues++; 
    issueDetails.push(`❌ ${file}: Missing Status field`); 
  } else { 
    const statusValue = statusMatch[1].trim(); 
    const validStatuses = ['Implemented', 'Partial', 'Proposed', 'Stale', 'Contradicted', 'Unverifiable']; 
    if (!validStatuses.includes(statusValue)) { 
      issues++; 
      issueDetails.push(`❌ ${file}: Invalid Status value: "${statusValue}"`); 
    } 
  } 
 
  // Check for last-reviewed date 
  const lastReviewedMatch = content.match(/^Last-reviewed:\s*(\d{4}-\d{2}-\d{2})/m); 
  if (!lastReviewedMatch) { 
    issues++; 
    issueDetails.push(`⚠️ ${file}: Missing last-reviewed date`); 
  } else { 
    // Validate date format 
    const dateStr = lastReviewedMatch[1]; 
    const dateParts = dateStr.split('-'); 
    if (dateParts.length !== 3 || 
        !dateParts[0] || parseInt(dateParts[0]) < 2000 || parseInt(dateParts[0]) > 2100 || 
        !dateParts[1] || parseInt(dateParts[1]) < 1 || parseInt(dateParts[1]) > 12 || 
        !dateParts[2] || parseInt(dateParts[2]) < 1 || parseInt(dateParts[2]) > 31) { 
      issues++; 
      issueDetails.push(`❌ ${file}: Invalid last-reviewed date format: "${dateStr}"`); 
    } 
  } 
 
  // Check for Version field 
  const versionMatch = content.match(/^Version:\s*(.+)$/m); 
  if (!versionMatch) { 
    issues++; 
    issueDetails.push(`⚠️ ${file}: Missing Version field`); 
  } 
} 
 
// Check any .json files in the ADR directory for valid JSON 
const jsonFiles = fs.readdirSync(adrDir).filter(f => f.endsWith('.json')); 
for (const jsonFile of jsonFiles) { 
  const jsonPath = path.join(adrDir, jsonFile); 
  try { 
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')); 
    // If we get here, it's valid JSON 
  } catch (e) { 
    issues++; 
    issueDetails.push(`❌ ${jsonFile}: Invalid JSON - ${e.message}`); 
  } 
} 
 
console.log(`ADR Validation: ${checked} files checked, ${issues} issues found`); 
 
if (issues > 0) { 
  console.log('\nIssues found:'); 
  issueDetails.forEach(d => console.log(d)); 
  process.exit(1); 
} else { 
  console.log('\n✅ All ADRs valid'); 
  process.exit(0); 
}