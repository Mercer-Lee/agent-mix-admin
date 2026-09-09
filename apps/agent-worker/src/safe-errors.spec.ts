import { describe, expect, it } from "vitest";
import { classifyRuntimeError } from "./safe-errors";

describe("safe Runtime error classification", () => {
  it.each([
    [408, "provider_timeout", true],
    [429, "provider_rate_limited", true],
    [500, "provider_unavailable", true],
    [503, "provider_unavailable", true],
    [401, "provider_authentication", false],
    [400, "provider_invalid_response", false],
  ] as const)("classifies HTTP %s without exposing a provider message", (statusCode, code, retryable) => {
    expect(classifyRuntimeError({ statusCode, message: "sensitive upstream response" })).toEqual({
      code,
      retryable,
    });
  });

  it("retries structural network errors", () => {
    expect(classifyRuntimeError({ cause: { code: "ECONNRESET" } })).toEqual({
      code: "provider_unavailable",
      retryable: true,
    });
  });

  it("does not treat an arbitrary TypeError as a network failure", () => {
    expect(classifyRuntimeError(new TypeError("SDK/parser misuse"))).toEqual({
      code: "provider_invalid_response",
      retryable: false,
    });
  });
});
