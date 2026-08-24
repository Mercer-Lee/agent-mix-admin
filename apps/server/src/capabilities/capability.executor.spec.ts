import { CapabilityError, type CapabilityExecutionContext } from "@agentmix/core";
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditService } from "../audit/audit.service";
import type { AuthorizationService } from "../rbac/authorization.service";
import { CapabilityExecutor } from "./capability.executor";
import { CapabilityRegistry } from "./capability.registry";
import { defineCapability } from "./capability.types";

const context: CapabilityExecutionContext = {
  actorSubjectId: "11111111-1111-4111-8111-111111111111",
  agentSubjectId: "22222222-2222-4222-8222-222222222222",
  traceId: "trace-1",
  conversationId: "conversation-1",
};

describe("CapabilityExecutor", () => {
  let registry: CapabilityRegistry;
  let auditRecord: ReturnType<typeof vi.fn>;
  let permissionLookup: ReturnType<typeof vi.fn>;
  let executor: CapabilityExecutor;

  beforeEach(() => {
    registry = new CapabilityRegistry();
    auditRecord = vi.fn().mockResolvedValue(undefined);
    permissionLookup = vi.fn().mockResolvedValue(["users:read"]);
    executor = new CapabilityExecutor(
      registry,
      { getEffectivePermissionsForSubject: permissionLookup } as unknown as AuthorizationService,
      { record: auditRecord } as unknown as AuditService,
    );
  });

  function register(overrides: {
    outputSchema?: z.ZodType;
    execute?: (input: { search?: string }) => Promise<unknown>;
    auditInput?: (input: { search?: string }) => Record<string, unknown>;
  } = {}) {
    registry.register(
      defineCapability({
        manifest: {
          id: "users.search",
          version: "1.0.0",
          module: "users",
          description: "Search users",
          risk: "read",
          requiredPermissions: ["users:read"],
        },
        inputSchema: z.object({ search: z.string().optional(), password: z.string().optional() }).strict(),
        outputSchema: overrides.outputSchema ?? z.object({ total: z.number() }),
        execute: overrides.execute ?? (async () => ({ total: 1 })),
        audit: { input: overrides.auditInput ?? ((input) => ({ search: input.search ?? null })) },
      }),
    );
  }

  it("returns only capabilities allowed to both the user and agent", async () => {
    register();
    await expect(executor.listAvailable(context)).resolves.toHaveLength(1);

    permissionLookup.mockImplementation(async (_subjectId: string, type: string) =>
      type === "user" ? ["users:read"] : [],
    );
    await expect(executor.listAvailable(context)).resolves.toEqual([]);
  });

  it("reports an unknown capability with a stable error code", async () => {
    await expect(executor.execute("users.missing", {}, context)).rejects.toMatchObject({
      code: "CAPABILITY_NOT_FOUND",
    });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "capability.execution.failed", outcome: "failure" }),
    );
  });

  it.each([
    ["user lacks permission", [], ["users:read"]],
    ["agent lacks permission", ["users:read"], []],
    ["user has the wrong type or is disabled", null, ["users:read"]],
    ["agent has the wrong type or is disabled", ["users:read"], null],
  ])("denies execution when %s", async (_label, actorPermissions, agentPermissions) => {
    register();
    permissionLookup.mockImplementation(async (_subjectId: string, type: string) =>
      type === "user" ? actorPermissions : agentPermissions,
    );

    await expect(executor.execute("users.search", {}, context)).rejects.toMatchObject({
      code: "CAPABILITY_FORBIDDEN",
    });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: "capability.authorization.denied", outcome: "failure" }),
    );
  });

  it("rejects invalid input before running the handler", async () => {
    const handler = vi.fn().mockResolvedValue({ total: 1 });
    register({ execute: handler });

    await expect(executor.execute("users.search", { unknown: true }, context)).rejects.toMatchObject({
      code: "CAPABILITY_INPUT_INVALID",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects invalid handler output", async () => {
    register({ execute: async () => ({ total: "invalid" }) });

    await expect(executor.execute("users.search", {}, context)).rejects.toMatchObject({
      code: "CAPABILITY_OUTPUT_INVALID",
    });
  });

  it("wraps handler failures without writing their messages to audit metadata", async () => {
    register({ execute: async () => Promise.reject(new Error("database-password-leaked")) });

    const error = await executor.execute("users.search", {}, context).catch((caught) => caught);
    expect(error).toBeInstanceOf(CapabilityError);
    expect(error).toMatchObject({ code: "CAPABILITY_EXECUTION_FAILED" });
    expect(JSON.stringify(auditRecord.mock.calls)).not.toContain("database-password-leaked");
  });

  it("returns validated output and audits only projected metadata", async () => {
    register();

    await expect(
      executor.execute(
        "users.search",
        { search: "alice", password: "must-not-be-audited" },
        context,
      ),
    ).resolves.toEqual({ total: 1 });
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSubjectId: context.actorSubjectId,
        action: "capability.executed",
        outcome: "success",
        metadata: expect.objectContaining({
          agentSubjectId: context.agentSubjectId,
          traceId: context.traceId,
          input: { search: "alice" },
        }),
      }),
    );
    expect(JSON.stringify(auditRecord.mock.calls)).not.toContain("must-not-be-audited");
  });
});
