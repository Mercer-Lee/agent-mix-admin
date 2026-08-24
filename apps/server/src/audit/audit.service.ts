import { Injectable } from "@nestjs/common";
import { auditLogs } from "../database/schema";
import { DatabaseService } from "../database/database.service";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "password",
  "passwordhash",
  "token",
  "tokenhash",
]);

export function sanitizeAuditMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeAuditMetadata);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z]/g, "")))
        .map(([key, nested]) => [key, sanitizeAuditMetadata(nested)]),
    );
  }
  return value;
}

export interface AuditEvent {
  actorSubjectId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome: "success" | "failure";
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  async record(event: AuditEvent): Promise<void> {
    await this.database.db.insert(auditLogs).values({
      actorSubjectId: event.actorSubjectId ?? null,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId ?? null,
      outcome: event.outcome,
      metadata: (sanitizeAuditMetadata(event.metadata ?? {}) ?? {}) as Record<string, unknown>,
      ipAddress: event.ipAddress ?? null,
      userAgent: event.userAgent ?? null,
    });
  }
}
