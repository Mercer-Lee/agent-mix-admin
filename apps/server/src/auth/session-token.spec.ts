import { describe, expect, it } from "vitest";
import { createSessionToken, hashSessionToken, isSessionUsable } from "./session-token";

describe("session tokens", () => {
  it("generates opaque tokens and stores deterministic hashes", () => {
    const first = createSessionToken();
    const second = createSessionToken();
    expect(first).not.toBe(second);
    expect(hashSessionToken(first)).toHaveLength(64);
    expect(hashSessionToken(first)).toBe(hashSessionToken(first));
  });

  it("rejects expired and revoked sessions", () => {
    const now = new Date("2026-08-19T00:00:00Z");
    expect(isSessionUsable({ expiresAt: new Date("2026-08-19T01:00:00Z"), revokedAt: null }, now)).toBe(true);
    expect(isSessionUsable({ expiresAt: new Date("2026-08-18T23:00:00Z"), revokedAt: null }, now)).toBe(false);
    expect(
      isSessionUsable(
        { expiresAt: new Date("2026-08-19T01:00:00Z"), revokedAt: new Date("2026-08-18T23:00:00Z") },
        now,
      ),
    ).toBe(false);
  });
});
