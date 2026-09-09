import { describe, expect, it, vi } from "vitest";
import type { DatabaseService } from "../database/database.service";
import { AuditService, type AuditTransaction, sanitizeAuditMetadata } from "./audit.service";

describe("sanitizeAuditMetadata", () => {
  it("removes sensitive values recursively", () => {
    expect(
      sanitizeAuditMetadata({
        username: "admin",
        password: "secret",
        nested: { tokenHash: "hash", password_hash: "hash", roleIds: ["role-1"] },
        headers: { cookie: "session=value", accept: "application/json" },
        prompt: "do not persist",
        providerError: "raw upstream response",
      }),
    ).toEqual({
      username: "admin",
      nested: { roleIds: ["role-1"] },
    });
  });

  it("writes through the caller transaction when one is provided", async () => {
    const transactionValues = vi.fn().mockResolvedValue(undefined);
    const transactionInsert = vi.fn().mockReturnValue({ values: transactionValues });
    const databaseInsert = vi.fn();
    const service = new AuditService({
      db: { insert: databaseInsert },
    } as unknown as DatabaseService);

    await service.record(
      {
        actorSubjectId: "actor-1",
        action: "agent.updated",
        resourceType: "agent",
        resourceId: "agent-1",
        outcome: "success",
        metadata: { status: "active", prompt: "must not be stored" },
      },
      { insert: transactionInsert } as unknown as AuditTransaction,
    );

    expect(transactionInsert).toHaveBeenCalledOnce();
    expect(transactionValues).toHaveBeenCalledWith(
      expect.objectContaining({
        actorSubjectId: "actor-1",
        action: "agent.updated",
        resourceId: "agent-1",
        metadata: { status: "active" },
      }),
    );
    expect(databaseInsert).not.toHaveBeenCalled();
  });
});
