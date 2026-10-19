// Backwards-compatible wrapper.
//
// The canonical Vitest configuration now lives at the repository root
// (../vitest.config.js) so that a single `npm ci` at the root provides both
// the app and the test toolchain. Running `vitest` from inside `tests/`
// still works: Vitest walks up to find the root config.
//
// This file is kept so that existing tooling that points at
// `tests/vitest.config.js` continues to resolve.
export { default } from "../vitest.config.js";
