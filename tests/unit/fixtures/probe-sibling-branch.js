/**
 * A FIXTURE, not a handler.
 *
 * A resolver in the OTHER ARM of a conditional. The path answers the client
 * from one arm; the resolver sits in the other one.
 *
 * This is the shape the scope rule exists for. The rule says a resolver
 * counts for a path only when the resolver's chain of enclosing blocks is
 * the path's chain, compared from the outermost inward. A resolver in the
 * sibling arm is in a different block, so it does not run on this path, and
 * it cannot stand in for the path's own resolution.
 *
 * The weaker rule this replaced asked only whether the two shared a
 * FUNCTION. They do — both arms are in the same function — so the sibling
 * resolver counted, the path looked covered, and the scan reported the
 * tree as clean. That is how the rule was weakened once already without
 * anything noticing: the real tree contains no sibling-branch resolver, so
 * nothing exercised the difference.
 *
 * The resolver is written ABOVE the path on purpose. A resolver below the
 * path is never reached by it, and the scan already knows that from the
 * order of the lines — so a fixture built that way would prove the
 * ordering rather than the scope. Here the two are in the same function,
 * the resolver comes first, and only the SCOPE tells them apart.
 *
 * This file is never imported and never runs. It exists so the rule can be
 * pinned by a test rather than by a claim.
 */

import { HTTP_STATUS } from "../../../open-sse/config/runtimeConfig.js";

export async function siblingBranchHandler(provider, options) {
  const credentials = await getProviderCredentials(provider, null, null);

  if (options.strict) {
    // The resolver is in this arm. The path below is in the other one, and
    // the path never reaches it.
    markAccountUnavailable(
      credentials.connectionId,
      HTTP_STATUS.BAD_REQUEST,
      "The request could not be built",
      provider,
      null,
      { upstreamContacted: false },
    );
  } else {
    // The path: the client is answered here.
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "No credentials for provider");
  }

  return errorResponse(HTTP_STATUS.BAD_REQUEST, "No credentials for provider");
}
