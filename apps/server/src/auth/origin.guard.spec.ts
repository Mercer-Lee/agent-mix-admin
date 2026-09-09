import { describe, expect, it } from "vitest";
import { isAllowedRequestOrigin } from "./origin.guard";

const ADMIN_ORIGIN = "http://localhost:3100";

describe("OriginGuard", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("allows safe %s requests without Origin", (method) => {
    expect(isAllowedRequestOrigin(method, undefined, ADMIN_ORIGIN)).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "requires the exact configured Origin for unsafe %s requests",
    (method) => {
      expect(isAllowedRequestOrigin(method, ADMIN_ORIGIN, ADMIN_ORIGIN)).toBe(true);
      expect(isAllowedRequestOrigin(method, undefined, ADMIN_ORIGIN)).toBe(false);
      expect(isAllowedRequestOrigin(method, "https://attacker.example", ADMIN_ORIGIN)).toBe(false);
      expect(isAllowedRequestOrigin(method, `${ADMIN_ORIGIN}/`, ADMIN_ORIGIN)).toBe(false);
      expect(isAllowedRequestOrigin(method, "not-a-url", ADMIN_ORIGIN)).toBe(false);
    },
  );
});
