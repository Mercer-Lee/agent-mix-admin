import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { describe, expect, it } from "vitest";
import { CreateAgentDto } from "./create-agent.dto";
import { ListAgentsDto } from "./list-agents.dto";
import { ReplaceAgentPermissionsDto } from "./replace-agent-permissions.dto";
import { UpdateAgentDto } from "./update-agent.dto";

const UUID = "019d2f5b-a8ab-7000-8000-000000000001";

describe("agent DTO validation", () => {
  it("normalizes a valid create payload and supplies assignment defaults", async () => {
    const dto = plainToInstance(CreateAgentDto, {
      slug: "  User-Query-Agent ",
      name: "  User Query Agent  ",
      description: "  Searches the user directory.  ",
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto).toMatchObject({
      slug: "user-query-agent",
      name: "User Query Agent",
      description: "Searches the user directory.",
      roleIds: [],
      permissionIds: [],
    });
  });

  it("rejects invalid slugs, duplicate assignments, and incomplete updates", async () => {
    const create = plainToInstance(CreateAgentDto, {
      slug: "Invalid Agent",
      name: "Agent",
      permissionIds: [UUID, UUID],
    });
    const update = plainToInstance(UpdateAgentDto, {
      name: "Agent",
      description: "",
      status: "paused",
      roleIds: [],
    });

    expect(await validate(create)).not.toHaveLength(0);
    expect(await validate(update)).not.toHaveLength(0);
  });

  it("bounds list pagination and status filters", async () => {
    const dto = plainToInstance(ListAgentsDto, { page: "0", pageSize: "101", status: "paused" });
    expect(await validate(dto)).toHaveLength(3);
  });

  it("requires unique UUIDs when replacing direct permissions", async () => {
    const dto = plainToInstance(ReplaceAgentPermissionsDto, { permissionIds: [UUID, UUID] });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
