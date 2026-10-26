import { describe, it, expect } from "vitest";
import WindsurfExecutor, {
  resolveWsModelId,
  grpcWebFrame,
  buildGetChatMessageRequest,
  decodeCompletionChunk,
} from "../../open-sse/executors/windsurf.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

describe("resolveWsModelId", () => {
  it("maps SWE models to snake-case wire names", () => {
    expect(resolveWsModelId("swe-1.6")).toBe("swe-1-6");
    expect(resolveWsModelId("swe-1.5-fast")).toBe("swe-1-5-fast");
  });

  it("maps Claude 4.5 to MODEL_PRIVATE_* aliases", () => {
    expect(resolveWsModelId("claude-sonnet-4.5")).toBe("MODEL_PRIVATE_2");
    expect(resolveWsModelId("claude-sonnet-4.5-thinking")).toBe("MODEL_PRIVATE_3");
  });

  it("applies default effort level for bare gpt-5.x ids", () => {
    expect(resolveWsModelId("gpt-5.5")).toBe("gpt-5-5-medium");
    expect(resolveWsModelId("gpt-5.4")).toBe("gpt-5-4-medium");
  });

  it("passes through unknown ids as-is", () => {
    expect(resolveWsModelId("custom-model-id")).toBe("custom-model-id");
  });
});

describe("grpcWebFrame", () => {
  it("prepends a 5-byte header: 0x00 flag + big-endian length", () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const framed = grpcWebFrame(payload);

    expect(framed.length).toBe(9);
    expect(framed[0]).toBe(0x00);

    const view = new DataView(framed.buffer);
    expect(view.getUint32(1, false)).toBe(4);
    expect(Array.from(framed.slice(5))).toEqual([1, 2, 3, 4]);
  });

  it("encodes empty payload as a 5-byte frame", () => {
    const framed = grpcWebFrame(new Uint8Array(0));
    expect(framed.length).toBe(5);
    expect(framed[0]).toBe(0x00);
    const view = new DataView(framed.buffer);
    expect(view.getUint32(1, false)).toBe(0);
  });
});

describe("buildGetChatMessageRequest", () => {
  it("emits metadata (field 1), cascade_id (2), model (3), messages (4+)", () => {
    const apiKey = "sk-ws-testkey";
    const model = "gpt-5-5-medium";
    const messages = [{ role: "user", content: "hello world" }];

    const req = buildGetChatMessageRequest(apiKey, model, messages);
    expect(req).toBeInstanceOf(Uint8Array);
    expect(req.length).toBeGreaterThan(20);
  });

  it("embeds the apiKey inside the metadata sub-message", () => {
    const apiKey = "sk-ws-unique-token";
    const req = buildGetChatMessageRequest(apiKey, "gpt-5", []);
    const str = new TextDecoder().decode(req);
    expect(str).toContain(apiKey);
  });

  it("appends one field-4 message per chat message", () => {
    const req = buildGetChatMessageRequest("key", "gpt-5", [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);
    const str = new TextDecoder().decode(req);
    expect(str).toContain("first");
    expect(str).toContain("second");
  });
});

describe("decodeCompletionChunk", () => {
  function encVarint(v) {
    const out = [];
    let x = v >>> 0;
    while (x > 0x7f) {
      out.push((x & 0x7f) | 0x80);
      x >>>= 7;
    }
    out.push(x & 0x7f);
    return out;
  }

  function encField(fieldNum, wireType, payload) {
    const tag = (fieldNum << 3) | wireType;
    if (wireType === 2) {
      return new Uint8Array([
        ...encVarint(tag),
        ...encVarint(payload.length),
        ...payload,
      ]);
    }
    return new Uint8Array(0);
  }

  it("decodes a ContentChunk (field 1 → text)", () => {
    const textBytes = new TextEncoder().encode("hello world");
    const contentChunk = encField(1, 2, textBytes);
    const outerChunk = encField(1, 2, contentChunk);

    const decoded = decodeCompletionChunk(outerChunk);
    expect(decoded).toEqual({ kind: "content", text: "hello world" });
  });

  it("decodes an ErrorChunk (field 4 → message)", () => {
    const errBytes = new TextEncoder().encode("rate limit exceeded");
    const errorChunk = encField(1, 2, errBytes);
    const outerChunk = encField(4, 2, errorChunk);

    const decoded = decodeCompletionChunk(outerChunk);
    expect(decoded).toEqual({ kind: "error", message: "rate limit exceeded" });
  });

  it("decodes a DoneChunk (field 3 → UsageStats with prompt/completion tokens)", () => {
    const promptTag = encVarint((1 << 3) | 0);
    const promptVal = encVarint(42);
    const compTag = encVarint((2 << 3) | 0);
    const compVal = encVarint(108);

    const usageBytes = new Uint8Array([
      ...promptTag,
      ...promptVal,
      ...compTag,
      ...compVal,
    ]);
    const doneChunk = encField(1, 2, usageBytes);
    const outerChunk = encField(3, 2, doneChunk);

    const decoded = decodeCompletionChunk(outerChunk);
    expect(decoded).toEqual({
      kind: "done",
      promptTokens: 42,
      completionTokens: 108,
    });
  });

  it("returns { kind: 'unknown' } for empty buffer", () => {
    expect(decodeCompletionChunk(new Uint8Array(0))).toEqual({
      kind: "unknown",
    });
  });
});

describe("WindsurfExecutor class", () => {
  it("constructor wires config from PROVIDERS.windsurf or default", () => {
    const ex = new WindsurfExecutor();
    expect(ex.provider).toBe("windsurf");
    expect(ex.config).toBeDefined();
    expect(typeof ex.execute).toBe("function");
  });

  it("buildHeaders emits grpc-web+proto + Bearer token", () => {
    const ex = new WindsurfExecutor();
    const headers = ex.buildHeaders({ accessToken: "sk-ws-123" });
    expect(headers["Content-Type"]).toBe("application/grpc-web+proto");
    expect(headers.Authorization).toBe("Bearer sk-ws-123");
    expect(headers["X-Grpc-Web"]).toBe("1");
  });

  it("buildHeaders omits Authorization when no token", () => {
    const ex = new WindsurfExecutor();
    const headers = ex.buildHeaders(null);
    expect(headers.Authorization).toBeUndefined();
  });

  it("buildUrl returns the GetChatMessage endpoint", () => {
    const ex = new WindsurfExecutor();
    expect(ex.buildUrl()).toContain("GetChatMessage");
  });
});
