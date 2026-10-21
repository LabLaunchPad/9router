/**
 * A FIXTURE, not a core.
 *
 * Four wrappers that rebuild a failure result and drop the fact on the way
 * out, one per shape:
 *
 *   1. a top-level declaration whose parameter is named after the result
 *   2. a nested helper
 *   3. a parameter with a different name
 *   4. an arrow function
 *
 * This file is never imported and never runs. It exists so the scan can be
 * shown catching every shape, and so the claim in
 * `PRODUCTION_READINESS_CONTROLS.md` — that the rule is a property of the
 * result and not of the shape the code is written in — is checkable rather
 * than asserted.
 *
 * The rule this file was written for asked two questions about the SHAPE of
 * a wrapper: is it a `function` declaration at the top level of a file, and
 * is one of its parameters named after a failure? Three of the four shapes
 * here escape that rule. The rule that replaced it asks what the result
 * carries, and it sees all four.
 */

/** Shape 1: a top-level declaration with a result parameter. */
export function wrapTopLevel(result) {
  return { success: false, status: result.status, error: result.error };
}

/** Shape 2: a nested helper. */
export function wrapNested(result) {
  function rebuild(inner) {
    return { success: false, status: inner.status, error: inner.error };
  }
  return rebuild(result);
}

/** Shape 3: a parameter with a different name. */
export function wrapRenamed(payload) {
  return { success: false, status: payload.status, error: payload.error };
}

/** Shape 4: an arrow function. */
export const wrapArrow = (outcome) => ({
  success: false,
  status: outcome.status,
  error: outcome.error,
});
