/**
 * A FIXTURE, not a handler.
 *
 * A resolver ABOVE the claim it is supposed to settle.
 *
 * The claim has not been made when the resolver runs, so the resolver
 * settles nothing — it settles an earlier request's claim, or no claim at
 * all. A rule that only asked "is there a resolver in this claim's scope"
 * would pass this file, because the resolver is in the same function and
 * in a success block; only the ORDER tells them apart.
 *
 * The first handler is settled, so the rule reaches the point where it
 * compares the claims with each other. Without the settled claim, the file
 * would be reported whole, and the order would make no difference.
 *
 * This file is never imported and never runs. It exists so the rule can be
 * pinned by a test rather than by a claim.
 */

export async function firstHandler(provider) {
  const credentials = await getProviderCredentials(provider, null, null);
  if (credentials) {
    await clearAccountError(credentials.connectionId, credentials);
    return new Response("first");
  }
  return errorResponse(400, "No credentials for provider");
}

export async function secondHandler(provider, result, earlier) {
  if (result.success) {
    // The resolver runs BEFORE the claim below. The claim has not been
    // made yet, so this settles nothing.
    await clearAccountError(earlier.connectionId, earlier);
  }

  const credentials = await getProviderCredentials(provider, null, null);
  if (credentials) {
    return new Response("second");
  }
  return errorResponse(400, "No credentials for provider");
}
