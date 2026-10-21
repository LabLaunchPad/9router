/**
 * Reading source code, as opposed to reading text.
 *
 * Three of this repository's controls scan source files — the probe scan,
 * the handler-layer scan and the marking scan — and every one of them asks
 * the same question in a different place: **is this line code, and is this
 * statement really saying what it appears to say?**
 *
 * A scan that reads text reads prose as well, and prose can be arranged to
 * say whatever the reader wants:
 *
 *     // markAccountUnavailable(connectionId, 400, "…", provider, model);
 *     } // markAccountUnavailable(connectionId, 400, "…", provider, model);
 *     log.info("called markAccountUnavailable(connectionId)");
 *
 *     /*
 *     return { success: false, status: 400, error: "…" };
 *     *\/
 *
 * A mention is not a call, a commented-out result is not a result, and a
 * control that cannot tell the difference is a control that can be
 * satisfied by writing a sentence — or, worse, one that can be *masked* by
 * a leftover sentence. Both directions have been real defects in this
 * repository.
 *
 * So the three scans share ONE reader, rather than each carrying its own
 * approximation of it. Three copies of a small parser is how three scans
 * drift apart in the first place, and the drift is invisible until one of
 * them is wrong.
 *
 * The reader is deliberately small, and it is deliberately conservative:
 * where it cannot tell code from prose, it says "not code", and the
 * control that uses it reports the path rather than hiding it. A control
 * that hides a path is worse than a control that raises a false alarm,
 * because the false alarm costs an hour and the hidden path costs an
 * incident.
 */

/**
 * The CODE of a text: everything that is not a comment, and not the
 * CONTENTS of a string.
 *
 * The text may be one line or a whole file. A `/* … *\/` block is carried
 * across the text either way, and a string's contents are removed for the
 * whole string, even when it runs past the end of a line.
 *
 * Newlines are kept, so the code of a file can be split back into lines
 * and a line can be matched to its place in the original.
 *
 * A string's CONTENTS are removed rather than its quotes, so a call that
 * sits in an argument position still reads as a call:
 *
 *     markAccountUnavailable(provider, "the upstream said no")
 *
 * The quotes are tracked while the text is walked, so a "//" inside a
 * string — a URL, most often — is not mistaken for the start of a comment.
 *
 * The two things this loses are a call made inside a template literal's
 * "${}", and a regular-expression literal that holds a quote. Neither
 * happens in the tree, and the failure mode is the safe one in both cases:
 * the call is not counted, so the path is reported rather than hidden.
 *
 * @param {string} text source text, one line or many
 * @returns {string} the code of that text
 */
export function codeOnly(text) {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inBlock) {
      if (ch === "*" && text[i + 1] === "/") {
        inBlock = false;
        i += 1;
        out += " "; // the comment's place is kept, so the line does not join up
      } else if (ch === "\n") {
        out += ch; // the line structure is kept
      }
      continue;
    }

    if (ch === "\\") {
      // An escaped character cannot end a string, and it cannot start a
      // comment either. A newline is escaped in a line continuation, and
      // the line structure has to survive it: the three scans match a line
      // of code to its place in the file, and a reader that lost a line
      // would shift every line after it.
      if (text[i + 1] === "\n") out += "\n";
      i += 1;
      continue;
    }

    if (ch === "'" && !inDouble && !inBacktick) {
      inSingle = !inSingle;
      out += ch;
      continue;
    }
    if (ch === '"' && !inSingle && !inBacktick) {
      inDouble = !inDouble;
      out += ch;
      continue;
    }
    if (ch === "`" && !inSingle && !inDouble) {
      inBacktick = !inBacktick;
      out += ch;
      continue;
    }

    if (!inSingle && !inDouble && !inBacktick) {
      if (ch === "/" && text[i + 1] === "/") {
        // The rest of the LINE is a comment. The newline is kept.
        const newline = text.indexOf("\n", i);
        if (newline === -1) break;
        i = newline - 1;
        continue;
      }
      if (ch === "/" && text[i + 1] === "*") {
        inBlock = true;
        i += 1;
        continue;
      }
      out += ch;
      continue;
    }

    // Inside a string: the contents are dropped, the quotes are kept.
    if (ch === "'" || ch === '"' || ch === "`") out += ch;
    else if (ch === "\n") out += ch;
  }

  return out;
}

/**
 * The code of a file, line by line.
 *
 * The lines come back in the same order and the same number as they went
 * in, so a line of code can be matched to its place in the original.
 *
 * @param {string[]} lines the lines of the file
 * @returns {string[]} the code of each line
 */
export function codeLines(lines) {
  return codeOnly(lines.join("\n")).split("\n");
}

/**
 * Which lines of a file are CODE.
 *
 * A line inside a block comment is not code, whatever it looks like: a
 * commented-out failure result is not a failure the core raises, and a
 * commented-out resolver is not a resolver. A comment's body does not
 * begin with a star — that is how block comments are usually written — so
 * the state is tracked across the file rather than decided one line at a
 * time.
 *
 * A line that holds a comment and nothing else is not code either, whether
 * the comment is a `//` or a `/* … *\/` that closes on the same line.
 *
 * @param {string[]} lines the lines of the file
 * @returns {boolean[]} true where the line is code
 */
export function codeLineFlags(lines) {
  const code = codeLines(lines);
  return lines.map((_, i) => (code[i] ?? "").trim().length > 0);
}
