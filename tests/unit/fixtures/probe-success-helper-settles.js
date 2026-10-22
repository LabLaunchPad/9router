/**
 * A FIXTURE, not a handler.
 *
 * A claim, and a HELPER that settles it.
 *
 * The resolver is in another function, so it is not in the claim's scope.
 * The rule has to say that a helper the claim's function calls DOES settle
 * the claim — a rule that only looked inside the claim's own scope would
 * report this file, and a control that reports correct code is a control
 * contributors learn to work around.
 *
 * This file is never imported and never runs. It exists so the rule can be
 * pinned by a test rather than by a claim.
 */

async function settleWhenItWorked(credentials, result) {
  if (result.success) {
    await clearAccountError(credentials.connectionId, credentials);
  }
}

export async function helperSettlesClaimHandler(provider, result) {
  const credentials = await getProviderCredentials(provider, null, null);
  if (!credentials) {
    return errorResponse(400, "No credentials for provider");
  }

  await settleWhenItWorked(credentials, result);

  return new Response("ok");
}
