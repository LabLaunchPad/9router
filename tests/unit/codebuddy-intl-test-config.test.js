/**
 * Regression test for #4232
 *
 * codebuddy-intl was missing from OAUTH_TEST_CONFIG. The test route handler
 * returned {"valid":false,"error":"Provider test not supported"} for every
 * codebuddy-intl account, regardless of token validity.
 *
 * Fix: add "codebuddy-intl": { tokenExists: true } alongside "codebuddy-cn".
 * Both providers use the same JWT token structure (eyJ…, ~1-year expiry,
 * access + refresh token pair) so the same test strategy applies.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Read the source file and verify the config entry is present.
// testUtils.js is a Next.js server file so we inspect the source text
// rather than importing it (avoids next/server bootstrap requirements).

// The path is resolved from THIS FILE's own location, not from the process
// working directory. The suite is run from the repository root, so the
// cwd-relative path this used to use ("../src/...") resolved to
// <drive>:/src/... and the file was not found — the suite failed to
// collect this file instead of reporting anything useful.
const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const src = fs.readFileSync(
  path.join(repoRoot, "src/app/api/providers/[id]/test/testUtils.js"),
  "utf-8"
);

describe("OAUTH_TEST_CONFIG — codebuddy-intl (#4232)", () => {
  it('contains "codebuddy-intl" entry', () => {
    expect(src).toContain('"codebuddy-intl"');
  });

  it('"codebuddy-intl" has tokenExists: true', () => {
    // Match the specific entry: "codebuddy-intl": { tokenExists: true }
    expect(src).toMatch(/"codebuddy-intl"\s*:\s*\{\s*tokenExists\s*:\s*true\s*\}/);
  });

  it('"codebuddy-cn" still has tokenExists: true (regression guard)', () => {
    expect(src).toMatch(/"codebuddy-cn"\s*:\s*\{\s*tokenExists\s*:\s*true\s*\}/);
  });
});