# Root Agent Guidelines for 9Router

This repository contains two main packages:
1. **Next.js Routing Gateway & Dashboard** (`src/`, `open-sse/`):
   - Single OpenAI-compatible gateway (`/v1/*`) and management dashboard.
   - Core routing logic in `open-sse/` (provider-agnostic) and `src/sse/` (Next.js glue).
   - Database persistence uses SQLite abstraction (`src/lib/db/`).
2. **CLI Launcher** (`cli/`):
   - Published npm package `9router` for starting/managing local process and tray.

## Agent Directives
- Always run tests via `npm test` from root.
- Do not modify generated file `open-sse/providers/registry/index.js` manually; use `scripts/migrate-registry.mjs`.
- Always check `docs/ARCHITECTURE.md` for runtime context.
