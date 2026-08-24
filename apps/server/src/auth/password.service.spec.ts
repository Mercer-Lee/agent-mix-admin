import { describe, expect, it } from "vitest";
import { PasswordService } from "./password.service";

describe("PasswordService", () => {
  const service = new PasswordService();

  it("hashes and verifies passwords with Argon2id", async () => {
    const hashed = await service.hash("correct-horse-battery-staple");
    expect(hashed).toContain("$argon2id$");
    await expect(service.verify(hashed, "correct-horse-battery-staple")).resolves.toBe(true);
    await expect(service.verify(hashed, "incorrect-password")).resolves.toBe(false);
  });

  it("runs dummy verification for missing users", async () => {
    await expect(service.verifyOrDummy(null, "unknown-password")).resolves.toBe(false);
  });
});
