import { describe, expect, it } from "vitest";
import { parseTrustProxy, validateEnvironment } from "./environment";

const BASE_ENVIRONMENT = {
  DATABASE_URL: "postgres://user:password@localhost:5432/agentmix",
};

describe("environment validation", () => {
  it("does not trust proxies by default", () => {
    expect(validateEnvironment(BASE_ENVIRONMENT).TRUST_PROXY).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
  });

  it("accepts only explicit IPv4 and IPv6 CIDRs", () => {
    expect(parseTrustProxy("10.0.0.0/8, 2001:db8::/32")).toEqual([
      "10.0.0.0/8",
      "2001:db8::/32",
    ]);
    expect(() => parseTrustProxy("true")).toThrow("TRUST_PROXY");
    expect(() => parseTrustProxy("10.0.0.1")).toThrow("TRUST_PROXY");
    expect(() => parseTrustProxy("10.0.0.0/33")).toThrow("TRUST_PROXY");
  });

  it("normalizes and validates ADMIN_ORIGIN as a serialized HTTP origin", () => {
    expect(validateEnvironment({ ...BASE_ENVIRONMENT, ADMIN_ORIGIN: "https://admin.example/" }).ADMIN_ORIGIN).toBe(
      "https://admin.example",
    );
    expect(() =>
      validateEnvironment({ ...BASE_ENVIRONMENT, ADMIN_ORIGIN: "https://admin.example/path" }),
    ).toThrow("Invalid environment configuration");
    expect(() =>
      validateEnvironment({ ...BASE_ENVIRONMENT, ADMIN_ORIGIN: "ftp://admin.example" }),
    ).toThrow("Invalid environment configuration");
  });
});
