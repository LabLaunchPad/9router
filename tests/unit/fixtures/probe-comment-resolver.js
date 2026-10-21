/**
 * A FIXTURE, not a handler.
 *
 * A path that was COMMENTED OUT, and resolvers that are only MENTIONED — in
 * a comment, in a trailing comment, and in a string. The path below owes a
 * resolution, and the success path owes one too, and the only things that
 * look like either are words.
 *
 * This is the shape that would make the scan report a covered path when
 * nothing covers it: a mention is not a call, and a control that counts
 * mentions as calls is a control that can be satisfied by writing a
 * sentence — or masked by a leftover one.
 *
 * Four shapes, because each is missed by a different filter:
 *
 *   1. a commented-out return       a path the request cannot take
 *   2. a leading comment            `// markAccountUnavailable(`
 *   3. a trailing comment           `} // markAccountUnavailable(`
 *   4. a mention inside a string    `log.info("... markAccountUnavailable(")`
 *
 * The commented-out return is written FIRST, on purpose. The scope of a
 * path is the chain of blocks it sits in, and a resolver is only in scope
 * if it is ABOVE it — so a return at the top of the function has nothing
 * above it, and the only thing that could cover it is a mention.
 *
 * The resolver in the comment below is written the way a developer writes
 * it when they are explaining what the code SHOULD do. That is exactly
 * when a scan that reads prose instead of code goes wrong.
 *
 * This file is never imported and never runs. It exists so the rule can be
 * pinned by a test rather than by a claim.
 */

import { HTTP_STATUS } from "../../../open-sse/config/runtimeConfig.js";

export async function commentOnlyResolverHandler(provider, result) {
  const credentials = await getProviderCredentials(provider, null, null);

  /*
  return errorResponse(HTTP_STATUS.BAD_REQUEST, "a path that was commented out");
  */

  // The right thing to do would be:
  // markAccountUnavailable(
  //   credentials.connectionId,
  //   HTTP_STATUS.BAD_REQUEST,
  //   "The request could not be built",
  //   provider,
  //   null,
  //   { upstreamContacted: false },
  // );

  if (result.success) {
    // And on the success path:
    // clearAccountError(credentials.connectionId, credentials, null);
  }

  log.info("the path would have called markAccountUnavailable(provider, status)");

  } // clearAccountError(credentials.connectionId, credentials, null);

  return errorResponse(HTTP_STATUS.BAD_REQUEST, "The request could not be built");
}
