// Shared system-prompt injector: appends an instruction into the system message of
// the final request body, dispatching by format so it works for translated and
// native-passthrough flows. Used by caveman.js and ponytail.js.

import { FORMATS } from "../translator/formats.js";
import { OPENAI_BLOCK, CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/blocks.js";
import { ROLE } from "../translator/schema/roles.js";

const SEP = "\n\n";

/**
 * Run a mutating step, failing open by default.
 *
 * Every injector below swallows mutation failures (frozen bodies, exotic
 * proxies) so a request is never lost over a cosmetic system-prompt tweak.
 * In strict mode the failure is rethrown so the caller can surface it.
 */
function tryMutate(fn, strict) {
  try {
    fn();
    return true;
  } catch (error) {
    if (strict) throw error;
    return false;
  }
}

export function injectSystemPrompt(body, format, prompt, strict = false) {
  try {
    if (!body || !prompt) return;
    if (typeof body !== "object") return;

    // Kiro wire shape is unique (conversationState) — handle directly.
    if (isKiroBody(body) || format === FORMATS.KIRO) {
      injectKiroSystem(body, prompt, strict);
      return;
    }

    // Claude/Gemini own a dedicated system field, yet their bodies also carry
    // messages[]/contents[] — decide by format label before the shape sniff below.
    // Anthropic rejects a "system" role inside messages[] (no such input role).
    if (format === FORMATS.CLAUDE) {
      injectClaudeSystem(body, prompt, strict);
      return;
    }
    if (format === FORMATS.GEMINI || format === FORMATS.GEMINI_CLI
      || format === FORMATS.VERTEX || format === FORMATS.ANTIGRAVITY) {
      // Antigravity wraps Gemini shape in body.request → injectGeminiSystem handles it
      injectGeminiSystem(body, prompt, strict);
      return;
    }

    // Dispatch by actual wire shape for OpenAI-shaped formats.
    // instructions string takes precedence; messages[] means Chat; input[] means Responses.
    if (typeof body.instructions === "string") {
      injectInstructionsSystem(body, prompt, strict);
      return;
    }
    if (Array.isArray(body.messages)) {
      injectChatSystem(body, prompt, strict);
      return;
    }
    if (Array.isArray(body.input)) {
      // Responses input[]: empty array already normalized elsewhere; string stays untouched here
      injectResponsesInputSystem(body, prompt, strict);
      return;
    }
    if (typeof body.input === "string") {
      // string input must stay untouched
      return;
    }

    // OpenAI-shaped but no array (e.g. empty body) — no-op
  } catch (error) {
    // Fail-open by default: a body we cannot mutate is still a usable body,
    // just without the injected instruction.
    // Strict mode is opt-in (RTK_STRICT=true) and rethrows so the caller can
    // surface the failure rather than silently shipping a request that is
    // missing its instruction.
    if (strict) throw error;
  }
}

function isKiroBody(body) {
  if (!body || typeof body !== "object") return false;
  const cs = body.conversationState;
  if (!cs || typeof cs !== "object") return false;
  // A top-level `systemPrompt` used to be the marker, but the Kiro translator no
  // longer emits it (kiro.dev rejects the field), so gate on the turn shape.
  const historyTurn = Array.isArray(cs.history)
    && cs.history.some(it => it && (it.userInputMessage || it.assistantResponseMessage));
  return historyTurn || !!(cs.currentMessage && cs.currentMessage.userInputMessage);
}

// Exact idempotency: prompt present as its own SEP-delimited segment (or the
// whole string), not as a substring of unrelated text.
function hasPrompt(haystack, prompt) {
  if (!haystack || typeof haystack !== "string") return false;
  if (haystack === prompt) return true;
  return haystack.split(SEP).includes(prompt);
}

function dedupStringAppend(curr, prompt) {
  if (!curr) return prompt;
  if (hasPrompt(curr, prompt)) return curr;
  return `${curr}${SEP}${prompt}`;
}

// ---- OpenAI instructions string ----
function injectInstructionsSystem(body, prompt, strict = false) {
  try {
    const curr = body.instructions;
    if (typeof curr !== "string") return;
    if (hasPrompt(curr, prompt)) return;
    const next = curr ? `${curr}${SEP}${prompt}` : prompt;
    tryMutate(() => { body.instructions = next; }, strict);
  } catch (error) {
    if (strict) throw error;
  }
}

// ---- Chat messages[] ----
function injectChatSystem(body, prompt, strict = false) {
  try {
    const arr = body.messages;
    if (!Array.isArray(arr)) return;
    // Exact idempotency: scan existing system/developer content for full prompt
    if (containsPromptInMessages(arr, prompt)) return;
    let idx = -1;
    try { idx = arr.findIndex(m => m && (m.role === ROLE.SYSTEM || m.role === ROLE.DEVELOPER)); } catch (error) { if (strict) throw error; return; }
    if (idx >= 0) {
      appendToChatMessage(arr[idx], prompt, strict);
    } else {
      // create typed system message at index 0; fail-open on frozen/proxy
      tryMutate(() => { arr.unshift({ role: ROLE.SYSTEM, content: prompt }); }, strict);
    }
  } catch (error) {
    if (strict) throw error;
  }
}

function containsPromptInMessages(arr, prompt) {
  try {
    for (const m of arr) {
      if (!m || (m.role !== ROLE.SYSTEM && m.role !== ROLE.DEVELOPER)) continue;
      const c = m.content;
      if (typeof c === "string" && hasPrompt(c, prompt)) return true;
      if (Array.isArray(c)) {
        for (const part of c) {
          if (part && typeof part.text === "string" && hasPrompt(part.text, prompt)) return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

function appendToChatMessage(msg, prompt, strict = false) {
  try {
    if (!msg || typeof msg !== "object") return;
    const c = msg.content;
    if (typeof c === "string") {
      const next = dedupStringAppend(c, prompt);
      if (next === c) return;
      // avoid partial mutation: try assignment, bail if setter throws
      tryMutate(() => { msg.content = next; }, strict);
      return;
    }
    if (Array.isArray(c)) {
      // already deduped at message level; but guard block-level too
      try {
        if (c.some(b => b && b.text === prompt)) return;
      } catch (error) { if (strict) throw error; }
      tryMutate(() => { c.push({ type: OPENAI_BLOCK.TEXT, text: prompt }); }, strict);
      return;
    }
    tryMutate(() => { msg.content = prompt; }, strict);
  } catch (error) {
    if (strict) throw error;
  }
}

// ---- Responses input[] ----
function injectResponsesInputSystem(body, prompt, strict = false) {
  try {
    const arr = body.input;
    if (!Array.isArray(arr)) return;
    // instructions already handled above
    if (containsPromptInResponsesInput(arr, prompt)) return;
    // find system/developer message items only (type === message)
    let idx = -1;
    try {
      idx = arr.findIndex(m => m && m.type === RESPONSES_ITEM.MESSAGE && (m.role === ROLE.SYSTEM || m.role === ROLE.DEVELOPER));
    } catch (error) { if (strict) throw error; return; }
    if (idx >= 0) {
      appendToResponsesMessage(arr[idx], prompt, strict);
    } else {
      const msg = { type: RESPONSES_ITEM.MESSAGE, role: ROLE.SYSTEM, content: [{ type: RESPONSES_ITEM.INPUT_TEXT, text: prompt }] };
      tryMutate(() => { arr.unshift(msg); }, strict);
    }
  } catch (error) {
    if (strict) throw error;
  }
}

function containsPromptInResponsesInput(arr, prompt) {
  try {
    for (const item of arr) {
      if (!item || item.type !== RESPONSES_ITEM.MESSAGE) continue;
      if (item.role !== ROLE.SYSTEM && item.role !== ROLE.DEVELOPER) continue;
      const c = item.content;
      if (typeof c === "string" && hasPrompt(c, prompt)) return true;
      if (Array.isArray(c)) {
        for (const part of c) {
          if (part && typeof part.text === "string" && hasPrompt(part.text, prompt)) return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

function appendToResponsesMessage(msg, prompt, strict = false) {
  try {
    if (!msg || typeof msg !== "object") return;
    const c = msg.content;
    if (typeof c === "string") {
      const next = dedupStringAppend(c, prompt);
      if (next === c) return;
      tryMutate(() => { msg.content = next; }, strict);
      return;
    }
    if (Array.isArray(c)) {
      try { if (c.some(b => b && b.text === prompt)) return; } catch (error) { if (strict) throw error; }
      tryMutate(() => { c.push({ type: RESPONSES_ITEM.INPUT_TEXT, text: prompt }); }, strict);
      return;
    }
    tryMutate(() => { msg.content = [{ type: RESPONSES_ITEM.INPUT_TEXT, text: prompt }]; }, strict);
  } catch (error) {
    if (strict) throw error;
  }
}

// ---- Claude ----
function injectClaudeSystem(body, prompt, strict = false) {
  try {
    const sys = body.system;
    if (typeof sys === "string") {
      if (hasPrompt(sys, prompt)) return;
      const next = sys.length > 0 ? `${sys}${SEP}${prompt}` : prompt;
      tryMutate(() => { body.system = next; }, strict);
      return;
    }
    if (Array.isArray(sys)) {
      try { if (sys.some(b => b && b.text === prompt)) return; } catch (error) { if (strict) throw error; }
      const block = { type: CLAUDE_BLOCK.TEXT, text: prompt };
      let lastCacheIdx = -1;
      try {
        for (let i = sys.length - 1; i >= 0; i--) {
          if (sys[i]?.cache_control) { lastCacheIdx = i; break; }
        }
      } catch (error) { if (strict) throw error; }
      tryMutate(() => {
        if (lastCacheIdx >= 0) sys.splice(lastCacheIdx, 0, block);
        else sys.push(block);
      }, strict);
      return;
    }
    // absent/null
    tryMutate(() => { body.system = prompt; }, strict);
  } catch (error) {
    if (strict) throw error;
  }
}

// ---- Gemini ----
function injectGeminiSystem(body, prompt, strict = false) {
  try {
    let target = body;
    try {
      if (body.request && typeof body.request === "object") target = body.request;
    } catch (error) { if (strict) throw error; }
    let useSnake = false;
    try { useSnake = Object.prototype.hasOwnProperty.call(target, "system_instruction"); } catch (error) { if (strict) throw error; }
    const key = useSnake ? "system_instruction" : "systemInstruction";
    let sys;
    try { sys = target[key]; } catch (error) { if (strict) throw error; sys = undefined; }
    if (sys && Array.isArray(sys.parts)) {
      try { if (sys.parts.some(p => p && p.text === prompt)) return; } catch (error) { if (strict) throw error; }
      tryMutate(() => { sys.parts.push({ text: prompt }); }, strict);
      return;
    }
    tryMutate(() => { target[key] = { parts: [{ text: prompt }] }; }, strict);
  } catch (error) {
    if (strict) throw error;
  }
}

// ---- Kiro ----
// The prompt is appended to the first user turn's content — the same place the
// Kiro translator already mirrors the system text via its contentPrefix.
//
// A top-level `systemPrompt` is deliberately NOT written: the kiro.dev gateway
// answers any body carrying that field with
//   400 {"message":"Improperly formed request.","reason":"REQUEST_BODY_INVALID"}
// The translator stopped emitting it in v0.5.59, but this injector kept adding
// it back, so every kr/ model failed whenever an RTK prompt (caveman, ponytail)
// was active.
function injectKiroSystem(body, prompt, strict = false) {
  try {
    const cs = body.conversationState;
    let targetMsg = null;
    const hist = Array.isArray(cs?.history) ? cs.history : null;
    if (hist) {
      for (const item of hist) {
        if (item && item.userInputMessage) { targetMsg = item.userInputMessage; break; }
      }
    }
    if (!targetMsg && cs?.currentMessage?.userInputMessage) {
      targetMsg = cs.currentMessage.userInputMessage;
    }
    if (!targetMsg) return;

    const content = typeof targetMsg.content === "string" ? targetMsg.content : "";
    const next = dedupStringAppend(content, prompt);
    if (next === content) return; // already injected — idempotent across retries
    tryMutate(() => { targetMsg.content = next; }, strict);
  } catch (error) {
    if (strict) throw error;
  }
}
