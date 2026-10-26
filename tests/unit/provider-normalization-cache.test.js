import { describe, it, expect } from "vitest";
import { normalizeProviderId, isXaiModel, normalizeProviderSpecificData } from "@/lib/providerNormalization";

describe("providerNormalization - performance & accuracy optimizations", () => {
  it("correctly normalizes direct provider IDs", () => {
    expect(normalizeProviderId("openai")).toBe("openai");
    expect(normalizeProviderId("anthropic")).toBe("anthropic");
    expect(normalizeProviderId("gemini")).toBe("gemini");
  });

  it("correctly normalizes provider slugs and whitespace", () => {
    expect(normalizeProviderId("  openai  ")).toBe("openai");
    expect(normalizeProviderId("OLLAMA-LOCAL")).toBe("ollama-local");
  });

  it("normalizes provider display names to canonical IDs", () => {
    expect(normalizeProviderId("Gemini")).toBe("gemini");
    expect(normalizeProviderId("Anthropic")).toBe("anthropic");
  });

  it("returns cached responses on repeated calls (O(1) constant time)", () => {
    const p1 = normalizeProviderId("  Gemini  ");
    const p2 = normalizeProviderId("  Gemini  ");
    expect(p1).toBe("gemini");
    expect(p2).toBe("gemini");
  });

  it("preserves non-string inputs", () => {
    expect(normalizeProviderId(null)).toBe(null);
    expect(normalizeProviderId(undefined)).toBe(undefined);
    expect(normalizeProviderId(123)).toBe(123);
  });

  it("detects xAI models correctly", () => {
    expect(isXaiModel("grok-3")).toBe(true);
    expect(isXaiModel("Grok_2_mini")).toBe(true);
    expect(isXaiModel("gpt-4o")).toBe(false);
  });

  it("normalizes provider specific data correctly", () => {
    const res = normalizeProviderSpecificData("ollama-local", { baseUrl: "http://localhost:11434" });
    expect(res).toEqual({ baseUrl: "http://localhost:11434" });
  });
});
