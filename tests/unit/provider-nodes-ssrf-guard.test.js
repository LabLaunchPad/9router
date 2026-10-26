import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) =>
      new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
  },
}));

const { POST } = await import(
  "../../src/app/api/provider-nodes/validate/route.js"
);

function remoteRequest(body) {
  return new Request("http://gateway.example.com/api/provider-nodes/validate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("provider-nodes validate SSRF guard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects loopback literal URLs from remote callers", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await POST(
      remoteRequest({ baseUrl: "http://127.0.0.1:8080", apiKey: "test-key" })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "URL not allowed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects wildcard-DNS hostnames resolving to internal IPs", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await POST(
      remoteRequest({ baseUrl: "http://127.0.0.1.nip.io:8080", apiKey: "test-key" })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "URL not allowed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
