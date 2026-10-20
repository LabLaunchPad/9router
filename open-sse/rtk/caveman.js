// Caveman injector: appends a caveman-style instruction into the system message
// of the final request body, just before it is dispatched to the provider executor.
// Strict mode: when rtkStrict=true (passed as 4th arg or from config), errors propagate instead of failing silently.

import { injectSystemPrompt } from "./systemInject.js";
import { CAVEMAN_PROMPTS } from "./cavemanPrompts.js";
import { rtkStrict } from "../config/runtimeConfig.js";

export function injectCaveman(body, format, level, rtkStrictOverride) {
  const strict = rtkStrictOverride !== undefined ? rtkStrictOverride : rtkStrict;
  try {
    // Pass strict down so injectSystemPrompt surfaces the failure instead of
    // swallowing it — otherwise the catch below could never fire.
    injectSystemPrompt(body, format, CAVEMAN_PROMPTS[level], strict);
  } catch (error) {
    if (strict) throw error;
  }
}
