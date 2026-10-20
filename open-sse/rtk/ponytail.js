// Ponytail injector: appends the "lazy senior dev" instruction into the system
// message of the final request body, just before dispatch to the provider executor.
// Strict mode: when rtkStrict=true (passed as 4th arg or from config), errors propagate instead of failing silently.

import { injectSystemPrompt } from "./systemInject.js";
import { PONYTAIL_PROMPTS } from "./ponytailPrompt.js";
import { rtkStrict } from "../config/runtimeConfig.js";

export function injectPonytail(body, format, level, rtkStrictOverride) {
  const strict = rtkStrictOverride !== undefined ? rtkStrictOverride : rtkStrict;
  try {
    // Pass strict down so injectSystemPrompt surfaces the failure instead of
    // swallowing it — otherwise the catch below could never fire.
    injectSystemPrompt(body, format, PONYTAIL_PROMPTS[level], strict);
  } catch (error) {
    if (strict) throw error;
  }
}
