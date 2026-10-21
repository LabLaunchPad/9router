/**
 * The reader the three source scans share.
 *
 * Three of this repository's controls — the probe scan, the handler-layer
 * scan and the marking scan — read source files, and all three of them
 * decide the same thing: is this line code, and is this statement really
 * saying what it appears to say?
 *
 * They share one reader, so the reader is a control in its own right, and
 * a control that is not tested is a control that only fails in production.
 * The shapes below are the ones that have actually broken a scan on this
 * branch: a mention in a comment, a mention in a string, a comment the
 * line filter could not see, and a string that holds a bracket.
 *
 * The reader's contract is deliberately one-sided. Where it cannot tell
 * code from prose, it says "not code", and the scan that uses it reports
 * the path rather than hiding it. A control that hides a path costs an
 * incident; a control that raises a false alarm costs an hour.
 */

import { describe, expect, it } from "vitest";
import { codeOnly, codeLines, codeLineFlags } from "./source-scan.js";

/** The code of a whole file, as a list of lines. */
const codeOf = (text) => codeLines(text.split("\n"));

describe("the shared reader: code, not prose", () => {
  it("reads a line comment as no code at all", () => {
    expect(codeOnly("// markAccountUnavailable(id, 400)").trim()).toBe("");
    expect(codeOnly("  // markAccountUnavailable(id, 400)").trim()).toBe("");
  });

  it("cuts a trailing comment off the code before it", () => {
    const code = codeOnly("const x = 1; // markAccountUnavailable(id, 400)");
    expect(code).toContain("const x = 1;");
    expect(code).not.toContain("markAccountUnavailable");
  });

  it("cuts a block comment off, on one line and across several", () => {
    expect(codeOnly("/* markAccountUnavailable(id, 400) */").trim()).toBe("");
    expect(codeOnly("const x = 1; /* markAccountUnavailable(id, 400) */")).not.toContain(
      "markAccountUnavailable",
    );

    const across = codeOnly("const x = 1;\n/* markAccountUnavailable(id, 400) */\nconst y = 2;");
    expect(across).not.toContain("markAccountUnavailable");
    expect(across).toContain("const x = 1;");
    expect(across).toContain("const y = 2;");
  });

  it("reads the body of a block comment as no code", () => {
    // The body of a block comment does not begin with a star — that is how
    // a person comments code out while they work — so a filter that
    // decides by the start of the line misses it.
    const lines = ["/*", "return { success: false, status: 400 };", "*/", "const x = 1;"];
    const flags = codeLineFlags(lines);

    expect(flags[0]).toBe(false);
    expect(flags[1]).toBe(false);
    expect(flags[2]).toBe(false);
    expect(flags[3]).toBe(true);
  });

  it("keeps a line that holds a comment and code", () => {
    const flags = codeLineFlags(["/* eslint-disable no-console */ const x = 1;"]);
    expect(flags[0]).toBe(true);
  });

  it("does not read a mention in a string as a call", () => {
    const code = codeOnly('log.info("called markAccountUnavailable(id, 400)");');
    expect(code).not.toContain("markAccountUnavailable");
  });

  it("does not mistake a URL for a comment", () => {
    // A "//" inside a string is a URL, not the start of a comment, and the
    // code after it is code.
    const code = codeOnly('const url = "https://example.com"; const x = 1;');
    expect(code).toContain("const x = 1;");
  });

  it("keeps the line structure, so a line can be matched to its place", () => {
    const lines = ["const a = 1;", "// a comment", "const b = 2;"];
    const code = codeOf(lines.join("\n"));

    expect(code.length).toBe(lines.length);
    expect(code[0]).toContain("const a = 1;");
    expect(code[1].trim()).toBe("");
    expect(code[2]).toContain("const b = 2;");
  });

  it("keeps the line structure when a line is continued", () => {
    // A backslash at the end of a line continues it. The reader has to
    // keep the line count, or every line after the continuation would be
    // matched to the wrong place in the file.
    const lines = ["const a = 1 + \\", "  2;", "const b = 3;"];
    const code = codeOf(lines.join("\n"));

    expect(code.length).toBe(lines.length);
    expect(code[2]).toContain("const b = 3;");
  });

  it("keeps a call that sits in an argument position", () => {
    // The string's CONTENTS are removed, not its quotes, so a call that
    // reads as an argument still reads as a call.
    const code = codeOnly('markAccountUnavailable(provider, "the upstream said no")');
    expect(code).toContain("markAccountUnavailable");
  });

  it("says not-code rather than guessing", () => {
    // A line it cannot read is not code. The scan that uses this reports
    // the path rather than hiding it, and that is the safe direction.
    expect(codeLineFlags(["   "])[0]).toBe(false);
    expect(codeLineFlags([""])[0]).toBe(false);
    expect(codeLineFlags(["* a stray star"])[0]).toBe(true);
  });
});
