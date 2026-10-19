import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

// Single source of truth for path aliases. Mirrors jsconfig.json "paths".
const alias = [
  { find: /^@\//, replacement: resolve(rootDir, "src") + "/" },
  { find: /^open-sse\//, replacement: resolve(rootDir, "open-sse") + "/" },
  { find: /^open-sse$/, replacement: resolve(rootDir, "open-sse") },
];

export default defineConfig({
  resolve: { alias },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.js"],
    // Don't scan into git worktrees nested under .claude/ — they carry their
    // own copies of the test files but lack an installed node_modules (open-sse,
    // etc.), which makes provider imports fail during collection.
    exclude: ["**/node_modules/**", "**/.claude/**", "**/dist/**", "tests/chaos/**"],
    // Allow many it.concurrent cases (real provider smoke runs ~50 providers in parallel)
    maxConcurrency: 60,
    // Suppress noisy console output from handlers under test
    silent: false,
    // The chaos suite is excluded from the default run and executed explicitly
    // (npm run test:chaos / the chaos-engineering workflow). It is deterministic
    // and network-free — failures are injected through dependency-injection
    // seams — so excluding it keeps the default run focused on unit coverage.
  },
});
