/**
 * A FIXTURE, not a core.
 *
 * It holds one failure result in CODE and one that has been commented out.
 *
 * The commented-out one is written the way a person comments code out
 * while they are working on it — inside a `/* … *\/` block whose body does
 * not begin with a star, because the stars are the *other* style and
 * nobody retypes them. A scan that decides "is this a comment?" by looking
 * at the start of the line misses it entirely.
 *
 * The consequence is not a missed defect. It is a false alarm about a
 * failure that does not exist: the build fails, and the error names a
 * failure result that is not there, and the next thing a contributor
 * learns is that the build is not to be trusted while they work.
 *
 * This file is never imported and never runs. It exists so the rule can
 * be pinned by a test rather than by a claim.
 */

export function handler() {
  return {
    success: false,
    status: 400,
    error: "the request could not be built",
    upstreamContacted: false,
  };
}

/*
return {
  success: false,
  status: 403,
  error: "this failure was commented out and is not raised",
};
*/
