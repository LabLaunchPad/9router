/**
 * A FIXTURE, not a core: the shapes the scan has to CATCH.
 *
 * Each shape is a failure a core could write by mistake, and each one is
 * invisible to a scan that only asks whether the fact is there:
 *
 *   1. a local 4xx raised through the constructor that says the provider
 *      WAS asked — the constructor is not evidence of the opposite
 *   2. a hand-built local 4xx that says the provider was asked
 *   3. a failure that says the provider was never asked and states its
 *      status as a variable, so nothing says which failure it is
 *   4. a local 4xx whose message holds an unbalanced bracket, with a
 *      statement below it that says the provider was never asked
 *
 * The fixture is never imported — the scan reads it as text — and it lives
 * outside the cores' directory, so the scan over the cores does not see it.
 */
import { createErrorResult, createLocalErrorResult } from "../../../open-sse/utils/error.js";
import { HTTP_STATUS } from "../../../open-sse/config/runtimeConfig.js";

/**
 * 1. The wrong constructor for a local failure: the request never left the
 * building, and the result says the provider was asked.
 */
export function localFailureThroughTheWrongConstructor() {
  return createErrorResult(
    HTTP_STATUS.BAD_REQUEST,
    "a local failure that never reached the provider",
  );
}

/**
 * 2. The same failure, written out by hand.
 */
export function localFailureThatClaimsItWasContacted() {
  return {
    success: false,
    status: 400,
    error: "a local failure that never reached the provider",
    upstreamContacted: true,
  };
}

/**
 * 3. The provider was never asked — and the status is a variable, so
 * nothing in the failure says that this is a client error.
 */
export function notContactedWithoutAWrittenStatus(providerStatus) {
  return createLocalErrorResult(providerStatus, "the provider was never asked");
}

/**
 * 4. A local failure that says nothing. The message holds two unbalanced
 * brackets, so a scan that counts brackets without looking at strings
 * reads the call's text past the end of the call — and the statement below
 * says the provider was never asked, which vouches for this failure.
 */
export function unmarkedLocalFailureWithABracketInTheMessage() {
  return localFailureResult(
    400,
    "the query is not valid (see the docs (for details",
  );
}

/** The statement below the call. It has nothing to do with the failure. */
export function laterStatement() {
  const unrelated = {
    upstreamContacted: false,
  };
  return unrelated;
}

/** A core's own wrapper — the shape a core writes for itself. */
function localFailureResult(status, error) {
  return { success: false, status, error };
}
