// tests/translator/golden-snapshot-portability.test.js
//
// A guard for the class of defect the golden snapshot had.
//
// THE DEFECT
// The branch committed a golden snapshot that recorded machine-dependent
// values:
//
//   "X-PLATFORM": "win32"             (process.platform)
//   "X-PLATFORM-VERSION": "v22.23.2" (process.version)
//   "User-Agent": "9Router/0.5.104"   (the app version)
//
// so the suite was RED on every runner that was not the machine that produced
// it — CI included. The interesting part is not the red: it is that the drift
// gate reported GREEN. The base commit has no snapshot at all, so it fails
// the same cases; the two sides were equally red, and "no NEW failures" was
// true. A green gate over a red suite, which is the one combination that
// teaches a reviewer to trust nothing.
//
// Two checks live here:
//   1. a property: the sanitised headers do not change when the platform and
//      the Node version change. That catches ANY header that starts carrying
//      machine state, including ones nobody has thought of yet;
//   2. a static check of the committed snapshot: it must not contain a
//      platform, a runtime version or the app version.
//
// The static check is the one that fails loudly if somebody commits a
// snapshot recorded on their own machine.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { sanitize, APP_VERSION, MACHINE_DEPENDENT_HEADERS } from "./golden-sanitize.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILE = path.join(HERE, "__snapshots__", "golden-url-header.test.js.snap");

// The providers that use the default executor — the same set the golden test
// covers. The specialised ones have their own executors and are not part of
// this snapshot.
const SPECIALIZED = new Set([
  "antigravity", "azure", "gemini-cli", "github", "iflow", "qoder", "kiro",
  "codex", "cursor", "vertex", "vertex-partner", "opencode",
  "opencode-go", "grok-web", "perplexity-web", "ollama-local", "commandcode",
  "xiaomi-tokenplan", "mimo-free",
]);

const API_KEY_CRED = { apiKey: "sk-test-APIKEY", providerSpecificData: {} };

// A platform value, as it would appear in a header.
const PLATFORM_LITERALS = [
  "win32", "linux", "darwin", "freebsd", "openbsd", "sunos", "aix", "android",
];

function headersFor(providerId) {
  const ex = new DefaultExecutor(providerId);
  const cred = PROVIDERS[providerId].noAuth ? {} : API_KEY_CRED;
  try {
    return sanitize(ex.buildHeaders(cred, true));
  } catch {
    return null;
  }
}

/**
 * Run `fn` with process.platform and process.version replaced.
 *
 * `process.platform` is a non-writable but CONFIGURABLE own property of the
 * process object, so it can be redefined and restored.
 */
function withMachine(platform, version, fn) {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const originalVersion = Object.getOwnPropertyDescriptor(process, "version");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "version", { value: version, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", originalPlatform);
    Object.defineProperty(process, "version", originalVersion);
  }
}

describe("the golden snapshot is portable", () => {
  afterEach(() => {
    // The property test restores the descriptors itself; this is a belt for
    // the case where it threw before the restore.
    if (!Object.getOwnPropertyDescriptor(process, "platform").value) {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    }
  });

  it("produces the same headers on a different platform and Node version", () => {
    const providerIds = Object.keys(PROVIDERS).filter((p) => !SPECIALIZED.has(p)).sort();

    const here = withMachine(process.platform, process.version, () =>
      providerIds.map((id) => [id, headersFor(id)])
    );
    const elsewhere = withMachine("linux", "v99.0.0", () =>
      providerIds.map((id) => [id, headersFor(id)])
    );

    // The platform and the Node version genuinely differ between the two runs,
    // so the check is not vacuous.
    expect(process.platform).not.toBe("linux");
    expect(here).toEqual(elsewhere);
  });

  it("records no platform, runtime version or app version in the snapshot", () => {
    const snapshot = fs.readFileSync(SNAPSHOT_FILE, "utf8");

    for (const literal of PLATFORM_LITERALS) {
      const found = snapshot.match(new RegExp(`"${literal}"`, "g"));
      expect(found, `the snapshot records the platform "${literal}"`).toBeNull();
    }

    if (APP_VERSION) {
      expect(snapshot.includes(APP_VERSION), "the snapshot records the app version").toBe(false);
    }

    // Every header the sanitiser normalises must appear with its placeholder
    // value, never with a concrete one.
    for (const [header, placeholder] of Object.entries(MACHINE_DEPENDENT_HEADERS)) {
      const pattern = new RegExp(`"${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":\\s*"([^"]*)"`, "g");
      for (const [, value] of snapshot.matchAll(pattern)) {
        expect(value, `the snapshot records a concrete value for ${header}`).toBe(placeholder);
      }
    }
  });

  it("normalises the platform, the runtime version and the app version", () => {
    expect(sanitize({ "X-PLATFORM": "linux" })).toEqual({ "X-PLATFORM": "<PLATFORM>" });
    expect(sanitize({ "X-PLATFORM-VERSION": "v99.0.0" })).toEqual({
      "X-PLATFORM-VERSION": "<NODE_VERSION>",
    });
    if (APP_VERSION) {
      expect(sanitize({ "User-Agent": `9Router/${APP_VERSION}` })).toEqual({
        "User-Agent": "9Router/<APP_VERSION>",
      });
    }
  });
});
