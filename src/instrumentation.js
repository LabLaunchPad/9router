export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Graceful-restart persistence for a small, non-sensitive slice of SSE
    // operational state (in-flight request counters, last error provider).
    // Registered here — before the app's own shutdown handler — so the
    // snapshot is written before that handler calls process.exit().
    const { registerStatePersistence, restorePersistedState } = await import("@/sse/services/state-persistence.js");
    await restorePersistedState();
    registerStatePersistence();
  }
}
