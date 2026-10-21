/**
 * A FIXTURE, not a handler.
 *
 * A resolver inside a CALLBACK. The callback fires when the upstream
 * request succeeds; the path below is the one that answers the client when
 * it does not.
 *
 * This is the second shape the scope rule exists for. The rule says a
 * resolver counts for a path only when the resolver's chain of enclosing
 * blocks is the path's chain — compared from the outermost inward. A
 * callback is its own block, and the path does not sit inside it, so the
 * callback's resolver says nothing about this path.
 *
 * The weaker rule this replaced asked only whether the two shared a
 * FUNCTION. They do — the callback is written inside the handler — so the
 * callback's resolver counted, the path looked covered, and the scan
 * reported the tree as clean.
 *
 * This file is never imported and never runs. It exists so the rule can be
 * pinned by a test rather than by a claim.
 */

import { HTTP_STATUS } from "../../../open-sse/config/runtimeConfig.js";

export async function callbackResolverHandler(provider, body) {
  const credentials = await getProviderCredentials(provider, null, null);

  const upstream = await callUpstream(credentials, body, {
    // The probe is resolved when the request SUCCEEDS. The path below is
    // the one that answers the client when it does not, and it never
    // reaches this callback.
    onRequestSuccess: () => {
      clearAccountError(credentials.connectionId, credentials, null);
    },
  });

  if (!upstream.ok) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "The request could not be built");
  }

  return upstream.response;
}
