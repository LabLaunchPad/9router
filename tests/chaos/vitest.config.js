import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));

// Chaos suite configuration.
//
// The chaos tests are excluded from the default run (root vitest.config.js)
// because they are destructive-by-design and must never gate a normal PR.
// Run them explicitly:
//
//   npx vitest run --config tests/chaos/vitest.config.js
//
// The suite itself is network-free: failures are injected through the
// existing dependency-injection seams rather than by contacting upstreams.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\//, replacement: resolve(rootDir, "src") + "/" },
      { find: /^open-sse\//, replacement: resolve(rootDir, "open-sse") + "/" },
      { find: /^open-sse$/, replacement: resolve(rootDir, "open-sse") },
    ],
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/chaos/**/*.test.js"],
    exclude: ["**/node_modules/**"],
    // Chaos scenarios may involve deliberate timeouts.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
