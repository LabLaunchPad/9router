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
//   1. a property: the sanitised headers do not change when the machine
//      changes — its platform, its Node version, or its architecture. That
//      catches ANY header that starts carrying machine state, including ones
//      nobody has thought of yet;
//   2. a static check of the committed snapshot: it must not record the
//      platform, the app version, or a concrete value for a header the
//      sanitiser knows to be machine-dependent.
//
// The static check is the one that fails loudly if somebody commits a
// snapshot recorded on their own machine.
//
// WHAT "THE MACHINE" MEANS HERE
// The machine is the platform, the Node version AND the architecture. This
// repository derives headers from all three: `open-sse/providers/shared.js`
// maps `process.arch` into `X-Stainless-Arch` and `process.platform` into
// `X-Stainless-Os`. A check that varies only the platform and the version
// would pass on a snapshot that leaked the architecture.
//
// The property test RE-IMPORTS the modules under each machine identity,
// because a value computed when a module is first evaluated is frozen with
// whatever the machine was at import time. Varying `process.arch` without
// re-importing would not change such a value, and the check would pass for
// the wrong reason.

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitize, APP_VERSION, MACHINE_DEPENDENT_HEADERS } from "./golden-sanitize.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILE = path.join(HERE, "__snapshots__", "golden-url-header.test.js.snap");
const REPO_ROOT = path.resolve(HERE, "../..");

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

// The descriptors as they were when the module was loaded. `process.platform`,
// `process.version` and `process.arch` are non-writable but CONFIGURABLE own
// properties of the process object, so they can be redefined — and they have
// to be put back exactly as they were, whatever the runner's machine is.
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, "platform");
const ORIGINAL_VERSION = Object.getOwnPropertyDescriptor(process, "version");
const ORIGINAL_ARCH = Object.getOwnPropertyDescriptor(process, "arch");

// The property tests re-import the provider modules under each machine
// identity, which is heavier than a plain call — and this suite runs
// alongside the whole test suite, so the default five seconds is not enough
// headroom on a loaded runner. Generous on purpose: a timeout should never
// be the reason this test fails.
const RE_IMPORT_TIMEOUT_MS = 30_000;

/**
 * Run `fn` with the machine replaced.
 */
async function withMachine(platform, version, arch, fn) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "version", { value: version, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
    Object.defineProperty(process, "version", ORIGINAL_VERSION);
    Object.defineProperty(process, "arch", ORIGINAL_ARCH);
  }
}

/**
 * The headers of every covered provider, built under a given machine
 * identity.
 *
 * The modules are re-imported INSIDE the identity, so a machine-dependent
 * value that is computed when a module is first evaluated is computed with
 * the stubbed machine rather than with this runner's.
 *
 * @returns {Promise<Array<[string, { raw: object|null, sanitized: object|null }]>>}
 */
async function headersUnder(platform, version, arch) {
  return withMachine(platform, version, arch, async () => {
    vi.resetModules();
    const [{ PROVIDERS }, { DefaultExecutor }] = await Promise.all([
      import("../../open-sse/config/providers.js"),
      import("../../open-sse/executors/default.js"),
    ]);

    return Object.keys(PROVIDERS)
      .filter((p) => !SPECIALIZED.has(p))
      .sort()
      .map((id) => {
        const ex = new DefaultExecutor(id);
        const cred = PROVIDERS[id].noAuth ? {} : API_KEY_CRED;
        let raw = null;
        try {
          raw = ex.buildHeaders(cred, true);
        } catch {
          raw = null;
        }
        return [id, { raw, sanitized: sanitize(raw) }];
      });
  });
}

/**
 * Every literal that the provider sources hardcode.
 *
 * A hardcoded literal is the same on every machine — that is the whole
 * difference between a fingerprint and a leak — so a literal that appears
 * here cannot be machine state.
 */
function hardcodedSourceLiterals() {
  const roots = ["open-sse/providers", "open-sse/config"];
  const text = [];
  for (const root of roots) {
    const dir = path.join(REPO_ROOT, root);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      text.push(fs.readFileSync(path.join(entry.parentPath ?? entry.path, entry.name), "utf8"));
    }
  }
  return text.join("\n");
}

describe("the golden snapshot is portable", () => {
  afterEach(() => {
    // The property test restores the descriptors itself; this is the belt for
    // the case where it threw before the restore. The originals are captured
    // at load time, so this puts back THIS runner's machine — a hard-coded
    // "win32" here would corrupt a Linux runner.
    Object.defineProperty(process, "platform", ORIGINAL_PLATFORM);
    Object.defineProperty(process, "version", ORIGINAL_VERSION);
    Object.defineProperty(process, "arch", ORIGINAL_ARCH);
  });

  it("produces the same headers on a different platform and Node version", async () => {
    // A platform and a Node version that are guaranteed to differ from this
    // runner's. "linux" would be a poor choice: the CI runner IS linux, and
    // the check would then compare linux against linux.
    const otherPlatform = process.platform === "darwin" ? "linux" : "darwin";
    const otherVersion = process.version === "v99.0.0" ? "v98.0.0" : "v99.0.0";

    const here = await headersUnder(process.platform, process.version, process.arch);
    const elsewhere = await headersUnder(otherPlatform, otherVersion, process.arch);

    // The RAW headers differ — the machine state really does reach them, so
    // the check below is not vacuous.
    expect(JSON.stringify(elsewhere.map(([, h]) => h.raw)))
      .not.toBe(JSON.stringify(here.map(([, h]) => h.raw)));

    // The SANITISED headers do not. That is the property the snapshot relies
    // on: the baseline reproduces on any machine.
    expect(here.map(([, h]) => h.sanitized)).toEqual(elsewhere.map(([, h]) => h.sanitized));
  }, RE_IMPORT_TIMEOUT_MS);

  it("produces the same headers on a different architecture", async () => {
    // The platform and the Node version are not the whole machine. This
    // repository derives headers from `process.arch` as well —
    // `open-sse/providers/shared.js` maps it into `X-Stainless-Arch` — so an
    // architecture-dependent header has to be caught too.
    //
    // The modules are re-imported under each identity, so a value computed at
    // module load is recomputed. Without that, this check would pass for the
    // wrong reason.
    const otherArch = process.arch === "arm64" ? "x64" : "arm64";

    const here = await headersUnder(process.platform, process.version, process.arch);
    const elsewhere = await headersUnder(process.platform, process.version, otherArch);

    expect(here.map(([, h]) => h.sanitized)).toEqual(elsewhere.map(([, h]) => h.sanitized));
  }, RE_IMPORT_TIMEOUT_MS);

  it("records no platform, no app version and no concrete machine-dependent value", () => {
    const snapshot = fs.readFileSync(SNAPSHOT_FILE, "utf8");

    for (const literal of PLATFORM_LITERALS) {
      const found = snapshot.match(new RegExp(`"${literal}"`, "g"));
      expect(found, `the snapshot records the platform "${literal}"`).toBeNull();
    }

    if (APP_VERSION) {
      expect(snapshot.includes(APP_VERSION), "the snapshot records the app version").toBe(false);
    }

    // The runner's own Node version must not be in the snapshot at all.
    // A literal that the provider sources hardcode is exempt: a hardcoded
    // fingerprint is the same on every machine, which is exactly what a leak
    // is not.
    const sources = hardcodedSourceLiterals();
    if (!sources.includes(process.version)) {
      expect(
        snapshot.includes(process.version),
        `the snapshot records this runner's Node version (${process.version})`,
      ).toBe(false);
    }

    // Every header the sanitiser normalises must appear with its placeholder
    // value, never with a concrete one. This is what covers the runtime
    // version: `X-PLATFORM-VERSION` is one of the machine-dependent headers,
    // so a concrete value for it cannot survive.
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
