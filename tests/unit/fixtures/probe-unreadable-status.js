/**
 * A FIXTURE, not a handler.
 *
 * Two paths that answer the client with a status the check CANNOT READ:
 * the status is a variable, so it may hold a local 4xx as well as an
 * upstream status.
 *
 * The rule is the one the document describes — a path whose status the
 * check cannot read is a path it asks about. A narrower rule, one that
 * reads the status only off an object, misses the shape below, and the
 * handlers that answer the client this way are exactly the ones the
 * no-answer check exists for.
 *
 * The first function is UNCOVERED: nothing resolves the probe on that
 * path, so the check has to report it.
 *
 * The second is COVERED: a resolver in the path's own scope resolves it.
 * A rule that asked about the second one anyway — or that reported it —
 * would be a rule that fights correct code, and a control that fights
 * correct code is a control contributors learn to work around.
 *
 * This file is never imported and never runs. It exists so the rule can be
 * pinned by a test rather than by a claim.
 */

import { HTTP_STATUS } from "../../../open-sse/config/runtimeConfig.js";

export async function unreadableStatusHandler(provider, status) {
  const credentials = await getProviderCredentials(provider, null, null);

  return unavailableResponse(status, `[${provider}] the request could not be built`);
}

export async function unreadableStatusResolvedHandler(provider, status) {
  const credentials = await getProviderCredentials(provider, null, null);

  markAccountUnavailable(
    credentials.connectionId,
    HTTP_STATUS.BAD_REQUEST,
    "The provider refused the request",
    provider,
    null,
    { upstreamContacted: false },
  );

  return unavailableResponse(status, `[${provider}] the provider refused the request`);
}
