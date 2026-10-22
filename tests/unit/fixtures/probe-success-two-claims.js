/**
 * A FIXTURE, not a handler.
 *
 * TWO claims, and only one of them is settled.
 *
 * This is the shape the per-CLAIM rule exists for. The rule used to ask
 * about the FILE: "does this file settle the probe on its success path?"
 * A file with two claims and one resolver passed that question — and the
 * claim the resolver does not reach leaked its probe, for the whole reset
 * window, for every handler that used the provider. The provider was
 * blackholed by a request that had already succeeded.
 *
 * The first claim is settled: the resolver is inside its own scope, below
 * it, on the success path. The second claim is not: nothing settles it, so
 * a successful request through it leaves the probe claimed.
 *
 * The real tree contains no such file — the two claims in every handler
 * are in different branches, and each branch has its own resolver. That is
 * exactly why a fixture is needed: the shape the rule exists to catch is
 * not in the tree, so nothing else would exercise the difference.
 *
 * This file is never imported and never runs. It exists so the rule can be
 * pinned by a test rather than by a claim.
 */

export async function twoClaimsOneSettledHandler(provider, options) {
  const first = await getProviderCredentials(provider, null, null);

  if (first) {
    if (options.ok) {
      // The resolver is in this claim's own scope, below it, on the success
      // path. It settles this claim.
      await clearAccountError(first.connectionId, first);
      return new Response("first");
    }
  }

  // A second claim. Nothing settles it: a successful request through it
  // leaves the probe claimed.
  const second = await getProviderCredentials(provider, null, null);
  if (second) {
    return new Response("second");
  }

  return errorResponse(400, "No credentials for provider");
}
