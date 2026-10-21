/**
 * A FIXTURE, not a handler.
 *
 * Two calls to the breaker, side by side:
 *
 *   - the first writes the fact in a COMMENT, and does not pass it;
 *   - the second passes the fact, as the second one should.
 *
 * The handler-layer scan asks one question of every call site that hands a
 * failure to the breaker — does the statement say whether the provider was
 * contacted? — and it has to ask it of the CODE, not of the text.
 *
 * A fact written in a comment is not a fact the call carries. A call that
 * carries no fact falls back to the default, and the default is
 * *contacted*: a provider that never received the request is recorded as
 * one that answered, which closes the half-open circuit of a provider that
 * is still down. That is the defect the control exists to prevent, and a
 * control that reads text accepts a sentence.
 *
 * This file is never imported and never runs. It exists so the rule can be
 * pinned by a test rather than by a claim.
 */

export function commentFactHandler(provider) {
  // The fact is written here, in a comment, and the call does not carry
  // it. The scan has to say this call does not state the fact.
  markAccountUnavailable(
    "conn-1",
    400,
    "the request could not be built",
    provider,
    "model-x",
    // upstreamContacted: false,
  );
}

export function realFactHandler(provider) {
  // The same call, with the fact passed. The scan has to say this one
  // does state it — a control that rejects correct work is a control
  // contributors learn to work around.
  markAccountUnavailable(
    "conn-2",
    400,
    "the request could not be built",
    provider,
    "model-x",
    { upstreamContacted: false },
  );
}
