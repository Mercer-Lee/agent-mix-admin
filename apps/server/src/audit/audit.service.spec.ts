import { describe, expect, it } from "vitest";
import { sanitizeAuditMetadata } from "./audit.service";

describe("sanitizeAuditMetadata", () => {
  it("removes sensitive values recursively", () => {
    expect(
      sanitizeAuditMetadata({
        username: "admin",
        password: "secret",
        nested: { tokenHash: "hash", password_hash: "hash", roleIds: ["role-1"] },
        headers: { cookie: "session=value", accept: "application/json" },
      }),
    ).toEqual({
      username: "admin",
      nested: { roleIds: ["role-1"] },
      headers: { accept: "application/json" },
    });
  });
});
