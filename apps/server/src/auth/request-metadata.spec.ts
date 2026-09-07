import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { getRequestMetadata } from "./request-metadata";

describe("getRequestMetadata", () => {
  it("uses Express request.ip and never parses X-Forwarded-For itself", () => {
    const request = {
      headers: { "x-forwarded-for": "203.0.113.7" },
      ip: "127.0.0.1",
      get: (name: string) => (name === "user-agent" ? "AgentMix test" : undefined),
    } as unknown as Request;

    expect(getRequestMetadata(request)).toEqual({
      ipAddress: "127.0.0.1",
      userAgent: "AgentMix test",
    });
  });
});
