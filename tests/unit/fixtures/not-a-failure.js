/**
 * A FIXTURE, not a core: an object that is NOT a failure result.
 *
 * A configuration object that happens to carry a `status:` property is not
 * a failure, and the scan must not judge it as one. If it does, the only
 * ways to satisfy the scan are to write a false statement on an object that
 * is not a failure, or to rename the property so the scan stops looking at
 * it — and both turn the control into something to work around.
 *
 * The fixture is never imported — the scan reads it as text — and it lives
 * outside the cores' directory, so the scan over the cores does not see it.
 */

export const retryPolicy = {
  status: 400,
  label: "the request was malformed",
};
