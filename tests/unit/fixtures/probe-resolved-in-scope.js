/**
 * A FIXTURE, not a handler.
 *
 * A resolver in the path's OWN scope: the release is made once, above the
 * branch, and the path below it is covered by it.
 *
 * This is the case that has to keep working. A rule that rejected every
 * resolver whose chain is not identical to the path's would reject this
 * one too, and a control that rejects correct code is a control
 * contributors learn to work around — with a redundant resolver, or with a
 * comment explaining that the scan is wrong. Both of those have had to be
 * undone on this branch already.
 *
 * This file is never imported and never runs. It exists so the rule can be
 * pinned by a test rather than by a claim.
 */

import { HTTP_STATUS } from "../../../open-sse/config/runtimeConfig.js";

export async function resolvedInScopeHandler(provider) {
  const credentials = await getProviderCredentials(provider, null, null);

  // The release is made once, above the branch. Every path below it is
  // covered by it.
  markAccountUnavailable(
    credentials.connectionId,
    HTTP_STATUS.BAD_REQUEST,
    "The request could not be built",
    provider,
    null,
    { upstreamContacted: false },
  );

  return errorResponse(HTTP_STATUS.BAD_REQUEST, "The request could not be built");
}
