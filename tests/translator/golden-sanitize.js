// tests/translator/golden-sanitize.js
//
// The header sanitiser used by golden-url-header.test.js, extracted into its
// own module so that the portability guard (golden-snapshot-portability.test.js)
// uses the SAME function the snapshot is produced with.
//
// WHY IT EXISTS
// A golden snapshot is a baseline: it records what the code produced once, so
// that a later change that alters the output is caught. That only works if
// the baseline is reproducible — on any machine, at any release.
//
// The snapshot this branch committed was not. It recorded
//   "X-PLATFORM": "win32"           (process.platform)
//   "X-PLATFORM-VERSION": "v22.23.2" (process.version)
//   "User-Agent": "9Router/0.5.104" (the app version)
// so the suite was red on every runner that is not the machine that produced
// it. Worse, the drift gate reported GREEN: the base commit has no snapshot
// at all and fails the same cases, so both sides were equally red and "no new
// failures" was true. A green gate over a red suite.
//
// The rule this module encodes: a value that depends on the machine or on the
// release is normalised to a placeholder. The shape of the header is what the
// golden test locks; the machine's state is not.

import pkg from "../../package.json" with { type: "json" };

// Headers whose VALUE depends on the machine or on the release. Each is
// replaced wholesale by its placeholder.
//
// `X-PLATFORM` (process.platform) and `X-PLATFORM-VERSION` (process.version)
// are the ones that were missed: they are not obviously "machine" values,
// because they look like ordinary header content.
export const MACHINE_DEPENDENT_HEADERS = {
  // randomUUID() mới cho mỗi request
  "X-Mavis-Session-Id": "<UUID>",
  // timezone của máy chạy
  "X-Mavis-Timezone-Offset": "<TZ>",
  // hostname của máy chạy
  "X-Msh-Device-Name": "<HOST>",
  // OS/arch của máy chạy
  "X-Msh-Device-Model": "<MODEL>",
  // version của app — đổi mỗi lần release
  "X-Msh-Version": "<VERSION>",
  // process.platform của máy chạy — "win32" ở đây, "linux" ở CI
  "X-PLATFORM": "<PLATFORM>",
  // process.version của Node — khác nhau giữa các máy và các image CI
  "X-PLATFORM-VERSION": "<NODE_VERSION>",
};

// The app version travels inside a few headers (User-Agent, X-CLIENT-VERSION,
// X-CORE-VERSION). It changes on every release, so the baseline has to
// survive one — otherwise every release is a red suite.
export const APP_VERSION = pkg.version || "";
const APP_VERSION_PATTERN = APP_VERSION
  ? new RegExp(APP_VERSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
  : null;

/**
 * Normalise a header bag so that it does not depend on the machine.
 *
 * @param {Record<string, unknown>} headers
 * @returns {Record<string, unknown>}
 */
export function sanitize(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (typeof v !== "string") {
      out[k] = v;
      continue;
    }
    let value = v
      .replace(/Bearer .+/, "Bearer <TOK>")
      .replace(/sk-test-APIKEY|tok-test-ACCESS/g, "<CRED>")
      .replace(/kimi-\d{10,}/g, "kimi-<TS>");
    if (APP_VERSION_PATTERN) value = value.replace(APP_VERSION_PATTERN, "<APP_VERSION>");
    out[k] = MACHINE_DEPENDENT_HEADERS[k] ?? value;
  }
  return out;
}
