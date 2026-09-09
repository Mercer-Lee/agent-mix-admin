import { Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import { auditLogs, conversationMessages, conversations } from "../database/schema";
import { DatabaseService } from "../database/database.service";
import type { ListAuditDto, ListConversationAuditDto } from "./dto/list-audit.dto";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "cookie",
  "password",
  "passwordhash",
  "token",
  "tokenhash",
  "apikey",
  "credential",
  "credentials",
  "headers",
  "prompt",
  "response",
  "systemprompt",
  "toolresult",
  "providererror",
  "rawerror",
  "baseurl",
  "content",
  "messages",
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

export type AuditTransaction = Parameters<
  Parameters<DatabaseService["db"]["transaction"]>[0]
>[0];

@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}

  async record(event: AuditEvent, transaction?: AuditTransaction): Promise<void> {
    const values = {
      actorSubjectId: event.actorSubjectId ?? null,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId ?? null,
      outcome: event.outcome,
      metadata: (sanitizeAuditMetadata(event.metadata ?? {}) ?? {}) as Record<string, unknown>,
      ipAddress: event.ipAddress ?? null,
      userAgent: event.userAgent ?? null,
    };
    if (transaction) {
      await transaction.insert(auditLogs).values(values);
      return;
    }
    await this.database.db.insert(auditLogs).values(values);
  }

  async listEvents(query: ListAuditDto) {
    const conditions = [
      query.actorSubjectId ? eq(auditLogs.actorSubjectId, query.actorSubjectId) : undefined,
      query.action ? eq(auditLogs.action, query.action) : undefined,
      query.resourceType ? eq(auditLogs.resourceType, query.resourceType) : undefined,
      query.from ? gte(auditLogs.createdAt, new Date(query.from)) : undefined,
      query.to ? lte(auditLogs.createdAt, new Date(query.to)) : undefined,
    ].filter((condition) => condition !== undefined);
    const where = conditions.length ? and(...conditions) : undefined;
    const [items, totals] = await Promise.all([
      this.database.db
        .select()
        .from(auditLogs)
        .where(where)
        .orderBy(desc(auditLogs.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.database.db.select({ value: count() }).from(auditLogs).where(where),
    ]);
    return {
      items: items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
      })),
      total: totals[0]?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async listConversations(query: ListConversationAuditDto) {
    const values: unknown[] = [];
    const clauses: string[] = [];
    const add = (clause: string, value: unknown) => {
      values.push(value);
      clauses.push(clause.replace("?", `$${values.length}`));
    };
    if (query.userSubjectId) add("conversation.user_subject_id = ?", query.userSubjectId);
    if (query.agentSubjectId) add("conversation.agent_subject_id = ?", query.agentSubjectId);
    if (query.status) add("latest_run.status = ?", query.status);
    if (query.from) add("conversation.created_at >= ?", new Date(query.from));
    if (query.to) add("conversation.created_at <= ?", new Date(query.to));
    const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
    const offset = (query.page - 1) * query.pageSize;
    const listValues = [...values, query.pageSize, offset];
    const countResult = await this.database.pool.query<{ total: string }>(
      `select count(*)::text as total
         from conversations conversation
         left join lateral (
           select run.status from agent_runs run
            where run.conversation_id = conversation.id
            order by run.created_at desc limit 1
         ) latest_run on true
         ${where}`,
      values,
    );
    const result = await this.database.pool.query<{
      id: string;
      userSubjectId: string;
      username: string;
      displayName: string;
      agentSubjectId: string;
      agentSlug: string;
      agentName: string;
      latestStatus: string | null;
      modelProfileId: string | null;
      modelKey: string | null;
      modelId: string | null;
      usage: Record<string, unknown> | null;
      errorCode: string | null;
      runCompletedAt: Date | null;
      lastMessageAt: Date;
      deletedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    }>(
      `select conversation.id,
              conversation.user_subject_id as "userSubjectId",
              app_user.username, app_user.display_name as "displayName",
              conversation.agent_subject_id as "agentSubjectId",
              agent.slug as "agentSlug", agent.name as "agentName",
              latest_run.status as "latestStatus",
              latest_run.model_profile_id as "modelProfileId",
              latest_run.model_key as "modelKey",
              latest_run.model_id as "modelId",
              latest_run.usage,
              latest_run.error_code as "errorCode",
              latest_run.completed_at as "runCompletedAt",
              conversation.last_message_at as "lastMessageAt",
              conversation.deleted_at as "deletedAt",
              conversation.created_at as "createdAt",
              conversation.updated_at as "updatedAt"
         from conversations conversation
         join users app_user on app_user.subject_id = conversation.user_subject_id
         join agents agent on agent.subject_id = conversation.agent_subject_id
         left join lateral (
           select run.status, run.model_profile_id, profile.key as model_key,
                  profile.model_id, run.usage, run.error_code, run.completed_at
             from agent_runs run
             join model_profiles profile on profile.id = run.model_profile_id
            where run.conversation_id = conversation.id
            order by run.created_at desc limit 1
         ) latest_run on true
         ${where}
        order by conversation.last_message_at desc
        limit $${values.length + 1} offset $${values.length + 2}`,
      listValues,
    );
    return {
      items: result.rows.map((item) => ({
        ...item,
        runCompletedAt: item.runCompletedAt?.toISOString() ?? null,
        lastMessageAt: item.lastMessageAt.toISOString(),
        deletedAt: item.deletedAt?.toISOString() ?? null,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
      total: Number(countResult.rows[0]?.total ?? 0),
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async getConversation(conversationId: string) {
    const conversation = await this.database.pool.query<{
      id: string;
      userSubjectId: string;
      username: string;
      displayName: string;
      agentSubjectId: string;
      agentSlug: string;
      agentName: string;
      deletedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    }>(
      `select conversation.id,
              conversation.user_subject_id as "userSubjectId",
              app_user.username, app_user.display_name as "displayName",
              conversation.agent_subject_id as "agentSubjectId",
              agent.slug as "agentSlug", agent.name as "agentName",
              conversation.deleted_at as "deletedAt",
              conversation.created_at as "createdAt",
              conversation.updated_at as "updatedAt"
         from conversations conversation
         join users app_user on app_user.subject_id = conversation.user_subject_id
         join agents agent on agent.subject_id = conversation.agent_subject_id
        where conversation.id = $1`,
      [conversationId],
    );
    if (!conversation.rows[0]) throw new NotFoundException("Conversation not found");
    const runs = await this.database.pool.query<{
      id: string;
      status: string;
      attempt: number;
      modelProfileId: string;
      modelKey: string;
      modelId: string;
      usage: Record<string, unknown> | null;
      finishReason: string | null;
      errorCode: string | null;
      queuedAt: Date;
      startedAt: Date | null;
      completedAt: Date | null;
    }>(
      `select run.id, run.status, run.attempt,
              run.model_profile_id as "modelProfileId",
              profile.key as "modelKey", profile.model_id as "modelId",
              run.usage, run.finish_reason as "finishReason", run.error_code as "errorCode",
              run.queued_at as "queuedAt", run.started_at as "startedAt",
              run.completed_at as "completedAt"
         from agent_runs run
         join model_profiles profile on profile.id = run.model_profile_id
        where run.conversation_id = $1
        order by run.created_at`,
      [conversationId],
    );
    const item = conversation.rows[0];
    return {
      conversation: {
        ...item,
        deletedAt: item.deletedAt?.toISOString() ?? null,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      },
      runs: runs.rows.map((run) => ({
        ...run,
        queuedAt: run.queuedAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        completedAt: run.completedAt?.toISOString() ?? null,
      })),
    };
  }

  async getConversationMessages(conversationId: string) {
    const exists = await this.database.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!exists[0]) throw new NotFoundException("Conversation not found");
    const items = await this.database.db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(conversationMessages.createdAt);
    return {
      items: items.map((item) => ({
        id: item.id,
        role: item.role,
        content: item.content,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  }
}
