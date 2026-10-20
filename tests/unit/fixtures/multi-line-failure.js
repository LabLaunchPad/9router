/**
 * A FIXTURE, not a core.
 *
 * A local failure written as a call spread over several lines: the status
 * is on the second line, not the first.
 *
 * A scan that matches the constructor call against the LINE the status is
 * on never sees the call at all — the pattern wants the `(` and the status
 * together — and the failure goes unmarked. The scan reads statements, and
 * this is the shape that proves it.
 */

import { HTTP_STATUS } from "../../../open-sse/config/runtimeConfig.js";

/** A core's own wrapper — the shape a core writes for itself. */
function failureResult(status, message) {
  return { success: false, status, error: message };
}

export function multiLineLocalFailure() {
  // A local failure: the request never reached the provider, and the
  // wrapper does not carry the fact. The status is on the next line, so a
  // scan that reads lines would not see it either.
  return failureResult(
    HTTP_STATUS.BAD_REQUEST,
    "a local failure that never reached the provider"
  );
}
