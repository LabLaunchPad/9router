/**
 * A FIXTURE, not a handler.
 *
 * A claim inside a conditional, and the success callback that settles it
 * created FURTHER DOWN the same block.
 *
 * This is the shape that stopped the earlier attempt at the per-claim
 * rule. The claim sits inside an `if`, the callback that settles it is
 * created after the `if` closes, and a scope model that reads "the
 * resolver has to be inside the claim's scope" refuses it — the callback
 * is not inside the `if`. The rule was right about the FAILURE path and
 * wrong about the SUCCESS path, and it flagged a file that is correct.
 *
 * The search path is written exactly like this.
 *
 * The claim is settled when the callback is CREATED after it, in a block
 * that encloses the claim's block: the claim's flow reaches the call that
 * takes the callback, and the core calls it when the request succeeds.
 *
 * This file is never imported and never runs. It exists so the rule can be
 * pinned by a test rather than by a claim.
 */

export async function claimThenCallbackHandler(provider) {
  let credentials = await getProviderCredentials(provider, null, null);

  if (!credentials) {
    credentials = await getProviderCredentials(provider, null, null);
  }

  const result = await handleCore({
    provider,
    onRequestSuccess: async () => {
      await clearAccountError(credentials.connectionId, credentials);
    },
  });

  return result;
}
