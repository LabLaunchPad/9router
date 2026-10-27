import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { handleChatCore, stripContinuityFields } from "../../open-sse/handlers/chatCore.js";
import { getCircuitBreaker, resetAllCircuitBreakers } from "../../open-sse/services/circuitBreaker.js";

describe("AI Gateway Benchmark & Reliability Tests", () => {
  let server;
  let serverPort;
  let serverUrl;

  beforeAll(async () => {
    resetAllCircuitBreakers();
    server = http.createServer((req, res) => {
      const url = req.url;
      if (url.includes("fast")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "fast-1", choices: [{ message: { role: "assistant", content: "Fast hello" } }] }));
      } else if (url.includes("slow-first-byte")) {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Slow " } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "world" } }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }, 150);
      } else if (url.includes("stream")) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Chunk 1 " } }] })}\n\n`);
        setTimeout(() => {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Chunk 2" } }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }, 20);
      } else if (url.includes("html-error")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<html><head><title>502 Bad Gateway</title></head><body>Cloudflare Error</body></html>");
      } else if (url.includes("500-error")) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Internal Upstream Error" } }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverPort = server.address().port;
    serverUrl = `http://127.0.0.1:${serverPort}`;
  });

  afterAll(async () => {
    resetAllCircuitBreakers();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it("measures gateway overhead for non-streaming fast JSON response", async () => {
    const credentials = {
      apiKey: "sk-mock-key",
      providerSpecificData: { baseUrl: serverUrl + "/fast" }
    };
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
      stream: false
    };

    const start = Date.now();
    const result = await handleChatCore({
      body,
      modelInfo: { provider: "openai-compatible-mock", model: "gpt-4o" },
      credentials,
      connectionId: "conn-bench-1",
      rtkEnabled: false
    });
    const duration = Date.now() - start;

    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("Fast hello");
    expect(duration).toBeLessThan(200); // Local HTTP roundtrip <200ms
  });

  it("handles streaming response and measures TTFT", async () => {
    const credentials = {
      apiKey: "sk-mock-key",
      providerSpecificData: { baseUrl: serverUrl + "/slow-first-byte" }
    };
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
      stream: true
    };

    const start = Date.now();
    const result = await handleChatCore({
      body,
      modelInfo: { provider: "openai-compatible-mock", model: "gpt-4o" },
      credentials,
      connectionId: "conn-bench-2",
      rtkEnabled: false
    });

    expect(result.success).toBe(true);
    const reader = result.response.body.getReader();
    const { value: firstChunk } = await reader.read();
    const ttft = Date.now() - start;

    expect(firstChunk).toBeDefined();
    expect(ttft).toBeGreaterThanOrEqual(140); // Includes ~150ms upstream delay

    let chunks = [new TextDecoder().decode(firstChunk)];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(new TextDecoder().decode(value));
    }
    const fullText = chunks.join("");
    expect(fullText).toContain("Slow");
    expect(fullText).toContain("world");
  });

  it("strips continuity fields across messages, input, and contents arrays", () => {
    const body = {
      messages: [{ role: "assistant", content: "hi", encrypted_content: "secret" }],
      input: [{ role: "user", reasoning_encrypted_content: "data" }],
      contents: [{ role: "model", encrypted_content: "hidden" }]
    };
    stripContinuityFields(body);
    expect(body.messages[0].encrypted_content).toBeUndefined();
    expect(body.input[0].reasoning_encrypted_content).toBeUndefined();
    expect(body.contents[0].encrypted_content).toBeUndefined();
  });

  it("handles non-SSE HTML error page from upstream safely without breaking stream pipeline", async () => {
    const credentials = {
      apiKey: "sk-mock-key",
      providerSpecificData: { baseUrl: serverUrl + "/html-error" }
    };
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
      stream: true
    };


    const result = await handleChatCore({
      body,
      modelInfo: { provider: "openai-compatible-mock", model: "gpt-4o" },
      credentials,
      connectionId: "conn-html-err",
      rtkEnabled: false
    });

    expect(result.success).toBe(false);
    expect(result.upstreamContacted).toBe(true);
    const errJson = await result.response.json();
    expect(errJson.error.message).toContain("502 Bad Gateway");
  });

  it("records circuit breaker metrics and states correctly on 500 errors", async () => {
    const cb = getCircuitBreaker("openai-compatible-mock", { failureThreshold: 2, coolDownWindowMs: 500 });
    cb.reset();

    const credentials = {
      apiKey: "sk-mock-key",
      providerSpecificData: { baseUrl: serverUrl + "/500-error" }
    };
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hello" }],
      stream: false
    };

    // 1st error
    await handleChatCore({
      body,
      modelInfo: { provider: "openai-compatible-mock", model: "gpt-4o" },
      credentials,
      connectionId: "conn-cb-1"
    });
    cb.recordFailure();
    expect(cb.getState().failureCount).toBe(1);
    expect(cb.getState().state).toBe("closed");

    // 2nd error -> reaches threshold 2
    cb.recordFailure();
    expect(cb.getState().state).toBe("open");
    expect(cb.canRequest()).toBe(false);
  });
});
