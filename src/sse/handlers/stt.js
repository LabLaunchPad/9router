import {
  extractApiKey, isValidApiKey,
  getProviderCredentials, markAccountUnavailable, clearAccountError, recordProviderFailure,
} from "../services/auth.js";
import { getSettings, getCustomModels } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { getKeyAccessContext, enforceKeyAccessResolved } from "../services/keyAccess.js";
import { handleSttCore } from "open-sse/handlers/sttCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import * as log from "../utils/logger.js";

// Providers requiring credentials for STT
const CREDENTIALED_PROVIDERS = new Set(
  Object.entries(AI_PROVIDERS)
    .filter(([, p]) => p.serviceKinds?.includes("stt") && !p.noAuth && p.sttConfig?.authType !== "none")
    .map(([id]) => id)
);

// Custom-model transport marker: models registered through
// /api/models/custom may pin a specialized STT transport (e.g.
// "gemini-live"). The engine dispatches on the marker itself, so the app
// layer only resolves it — same getModelInfo-style provider+model pairing,
// restricted to type "stt" records.
async function resolveCustomModelTransport(provider, model) {
  try {
    const customModels = await getCustomModels();
    const hit = customModels.find((c) => c && c.type === "stt"
      && c.providerAlias === provider && c.id === model
      && typeof c.transport === "string" && c.transport.trim());
    return hit ? hit.transport.trim() : null;
  } catch {
    return null; // DB unreadable → built-in registry marker still applies
  }
}

export async function handleStt(request) {
  let formData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart form data");
  }

  const modelStr = formData.get("model");
  log.request("POST", `/v1/audio/transcriptions | ${modelStr}`);

  const settings = await getSettings();
  if (settings.requireApiKey) {
    const apiKey = extractApiKey(request);
    if (!apiKey) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    const valid = await isValidApiKey(apiKey);
    if (!valid) return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!formData.get("file")) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing required field: file");

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");

  const { provider, model } = modelInfo;

  // Per-key access control: checked before any credential lookup.
  const keyAccessDenied = await enforceKeyAccessResolved(await getKeyAccessContext(request), modelStr, provider, model);
  if (keyAccessDenied) return keyAccessDenied;

  log.info("ROUTING", `Provider: ${provider}, Model: ${model}`);

  const modelTransport = await resolveCustomModelTransport(provider, model);

  // noAuth providers
  if (!CREDENTIALED_PROVIDERS.has(provider)) {
    // The circuit breaker is a provider-level control, and this path does
    // not go through getProviderCredentials - so it never consulted the
    // breaker, and its failures never tripped it. The credential lookup is
    // where the breaker is consulted (canRequest), so it is used here as
    // the gate. The credential itself is not used: this path needs none.
    const gate = await getProviderCredentials(provider, null, model);
    if (!gate) {
      // A no-auth provider has no credentials that could be missing, so the
      // only reason the lookup returns nothing is an open circuit. The
      // refusal is a 404, like every other circuit refusal, so it counts
      // as a request and not as a 5xx error.
      return errorResponse(HTTP_STATUS.NOT_FOUND, `Provider temporarily unavailable: ${provider}`);
    }

    const result = await handleSttCore({ provider, model, formData, sttConfig: AI_PROVIDERS[provider]?.sttConfig, transport: modelTransport });

    if (result.success) {
      // The lookup claimed the breaker's half-open probe, and only a
      // SUCCESS resolves it.
      await clearAccountError(gate.connectionId, gate, model);
      return result.response;
    }

    // A no-auth provider has no account to lock, so the failure is
    // recorded on the breaker directly.
    recordProviderFailure(provider, result.status);
    return errorResponse(result.status || HTTP_STATUS.BAD_GATEWAY, result.error || "STT failed");
  }

  // Credentialed — fallback loop
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model);

    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const msg = lastError || credentials.lastError || "Unavailable";
        const status = lastStatus || Number(credentials.lastErrorCode) || HTTP_STATUS.SERVICE_UNAVAILABLE;
        return unavailableResponse(status, `[${provider}/${model}] ${msg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) return errorResponse(HTTP_STATUS.BAD_REQUEST, `No credentials for provider: ${provider}`);
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    log.info("AUTH", `\x1b[32mUsing ${provider} account: ${credentials.connectionName}\x1b[0m`);

    const result = await handleSttCore({ provider, model, formData, credentials, sttConfig: AI_PROVIDERS[provider]?.sttConfig, transport: modelTransport });

    if (result.success) {
      // The credential lookup claimed the circuit breaker's half-open probe
      // (auth.js, canRequest()), and only a SUCCESS resolves it: the probe
      // asked "does this provider work now?", the provider answered, so the
      // probe succeeded. Without this, a provider that had recovered was
      // blackholed for the whole reset window - fifteen minutes by default -
      // for EVERY handler, not only this one.
      await clearAccountError(credentials.connectionId, credentials, model);
      return result.response;
    }

    const { shouldFallback } = await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model);
    if (shouldFallback) {
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }
    return result.response || errorResponse(result.status, result.error);
  }
}
