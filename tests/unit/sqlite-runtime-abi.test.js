// cli/hooks/sqliteRuntime.js — isBetterSqliteBinaryValid() must reject a native
// binary this runtime cannot actually load.
//
// Issue #2493: a better-sqlite3 built for a different Node major passed the
// magic-only check, because ELF/PE/Mach-O magic says nothing about the ABI. The
// load then segfaults, killing the process before the driver chain can fall back
// to node:sqlite / sql.js.
//
// The pinned build for Node >= 22 is better-sqlite3 13.x, whose prebuilds are
// N-API and therefore ABI-independent: they register through
// `napi_register_module_v1`. A binary without that marker is bound to the ABI
// that compiled it, so it is a leftover from an older runtime and must not be
// accepted.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const require = createRequire(import.meta.url);
const { isBetterSqliteBinaryValid } = require("../../cli/hooks/sqliteRuntime.js");

const PLATFORM = process.platform;
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
// The pinned build is N-API (and so the marker is required) on Node >= 22.
const NEEDS_NAPI = NODE_MAJOR >= 22;

// Valid native-binary magic per platform, so the magic gate passes and the
// assertion is actually exercising the ABI gate rather than the magic gate.
const MAGIC = {
  win32: [0x4d, 0x5a], // MZ
  darwin: [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64 LE
  linux: [0x7f, 0x45, 0x4c, 0x46], // \x7fELF
};
const MAGIC_BYTES = MAGIC[PLATFORM] || MAGIC.linux;

// The marker the loader resolves for an N-API module.
const NAPI_MARKER = Buffer.from("napi_register_module_v1");

let dataDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-abi-"));
  process.env.DATA_DIR = dataDir;
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function writeBinary(relativePath, { magic = MAGIC_BYTES, napi = false } = {}) {
  const file = path.join(dataDir, "runtime", "node_modules", "better-sqlite3", relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = napi ? Buffer.concat([Buffer.from(magic), NAPI_MARKER]) : Buffer.from(magic);
  fs.writeFileSync(file, bytes);
  return file;
}

// getBetterSqliteBinary() prefers build/Release, then prebuilds/<platform>-<arch>.
// On musl Linux the platform segment is "linuxmusl", so cover both spellings.
function prebuildPaths() {
  const names = [`${PLATFORM}-${process.arch}`];
  if (PLATFORM === "linux") names.push(`linuxmusl-${process.arch}`);
  return names.map((n) => path.join("prebuilds", `${n}.node`));
}

describe("cli/hooks/sqliteRuntime — better-sqlite3 ABI validation", () => {
  it("rejects a magic-valid binary that carries no N-API marker (#2493)", () => {
    // A leftover ABI-bound build: correct file magic, wrong ABI for this Node.
    for (const rel of prebuildPaths()) writeBinary(rel);
    expect(isBetterSqliteBinaryValid()).toBe(false);
  }, NEEDS_NAPI ? 10000 : 0);

  it("accepts an N-API binary, which is ABI-independent", () => {
    for (const rel of prebuildPaths()) writeBinary(rel, { napi: true });
    expect(isBetterSqliteBinaryValid()).toBe(true);
  });

  it("rejects a file whose magic is not a native binary", () => {
    for (const rel of prebuildPaths()) writeBinary(rel, { magic: [0x00, 0x01], napi: true });
    expect(isBetterSqliteBinaryValid()).toBe(false);
  });

  it("rejects when no better-sqlite3 binary exists at all", () => {
    expect(isBetterSqliteBinaryValid()).toBe(false);
  });
});
