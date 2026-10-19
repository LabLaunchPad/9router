// Port of apply_filter (rtk/src/cmds/system/pipe_cmd.rs) — catch_unwind equivalent
// On panic/error: passthrough raw output + warn to stderr
// Strict mode: when enabled, errors propagate instead of passing through raw output
export function safeApply(fn, text, rtkStrict = false) {
  if (typeof fn !== "function") return text;
  try {
    const out = fn(text);
    if (typeof out !== "string") return text;
    return out;
  } catch (err) {
    // Rust: eprintln!("[rtk] warning: filter panicked — passing through raw output")
    const name = fn.filterName || fn.name || "anonymous";
    if (rtkStrict) throw err;
    console.warn(`[rtk] warning: filter '${name}' panicked — passing through raw output: ${err?.message || err}`);
    return text;
  }
}
