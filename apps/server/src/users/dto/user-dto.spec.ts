import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { CreateUserDto } from "./create-user.dto";
import { ListUsersDto } from "./list-users.dto";

describe("user DTO validation", () => {
  it("normalizes a valid user payload", async () => {
    const dto = plainToInstance(CreateUserDto, {
      username: "  Operator.One ",
      password: "operator-password-123",
      displayName: "Operator One",
      email: " OPERATOR@EXAMPLE.COM ",
    });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.username).toBe("operator.one");
    expect(dto.email).toBe("operator@example.com");
  });

  it("rejects weak passwords and invalid usernames", async () => {
    const dto = plainToInstance(CreateUserDto, {
      username: "Invalid Name",
      password: "short",
      displayName: "Operator",
    });
    expect(await validate(dto)).not.toHaveLength(0);
  });

  it("bounds pagination inputs", async () => {
    const dto = plainToInstance(ListUsersDto, { page: "0", pageSize: "101" });
    expect(await validate(dto)).toHaveLength(2);
  });
});
