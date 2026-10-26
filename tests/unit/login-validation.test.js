import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  nextResponse: Symbol("next"),
  jsonResponse: vi.fn((body, init) => ({
    status: init?.status || 200,
    body,
    headers: init?.headers,
  })),
  getSettings: vi.fn(),
  getClientIp: vi.fn(() => "127.0.0.1"),
  bcryptCompare: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: mocks.jsonResponse,
  },
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => Promise.resolve({ set: vi.fn() })),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

vi.mock("bcryptjs", () => ({
  default: {
    compare: mocks.bcryptCompare,
  },
}));

vi.mock("@/lib/auth/loginLimiter", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getClientIp: mocks.getClientIp,
  };
});

vi.mock("@/dashboardGuard", () => ({
  isLocalRequest: vi.fn(() => true),
}));

vi.mock("@/lib/auth/oidc", () => ({
  isOidcConfigured: vi.fn(() => false),
}));

vi.mock("@/lib/auth/saml.js", () => ({
  isSamlConfigured: vi.fn(() => false),
}));

const { POST } = await import("../../src/app/api/auth/login/route.js");

function createMockRequest(body, options = {}) {
  const headers = new Headers(options.headers || {});
  return {
    headers,
    json: async () => {
      if (options.invalidJson) {
        throw new SyntaxError("Unexpected token in JSON");
      }
      return body;
    },
  };
}

describe("POST /api/auth/login input validation and security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({
      password: "$2a$10$storedhash", // bcrypt hash present
    });
    mocks.bcryptCompare.mockResolvedValue(false);
  });

  it("handles non-string password inputs (number, object, null, boolean) safely without 500 error", async () => {
    const invalidPayloads = [
      { password: 123456 },
      { password: { secret: "123456" } },
      { password: null },
      { password: true },
      { password: ["123456"] },
      {},
    ];

    let count = 1;
    for (const body of invalidPayloads) {
      mocks.getClientIp.mockReturnValue(`10.0.0.${count++}`);
      const req = createMockRequest(body);
      const res = await POST(req);

      // Should return 401 (invalid credentials) rather than crashing with 500
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Invalid password/);
      // bcrypt.compare should NOT be called with invalid non-string password
      expect(mocks.bcryptCompare).not.toHaveBeenCalled();
    }
  });

  it("handles malformed JSON payload safely without 500 error", async () => {
    mocks.getClientIp.mockReturnValue("10.0.1.1");
    const req = createMockRequest(null, { invalidJson: true });
    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid password/);
    expect(mocks.bcryptCompare).not.toHaveBeenCalled();
  });

  it("increments failure count and eventually locks out attackers attempting invalid payload fuzzing", async () => {
    const uniqueIp = "192.168.1.100";
    mocks.getClientIp.mockReturnValue(uniqueIp);

    // Make 5 invalid requests (non-string password)
    for (let i = 0; i < 5; i++) {
      const req = createMockRequest({ password: 12345 });
      const res = await POST(req);
      if (i < 4) {
        expect(res.status).toBe(401);
      } else {
        // 5th attempt triggers lockout
        expect(res.status).toBe(429);
        expect(res.body.error).toMatch(/Too many failed attempts/);
      }
    }
  });
});
