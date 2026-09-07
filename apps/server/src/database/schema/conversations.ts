import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { agents } from "./agents";
import { timestamps } from "./common";
import { modelChecks, modelProfiles } from "./models";
import { users } from "./organization";

export const conversationMessageRoleEnum = pgEnum("conversation_message_role", [
  "user",
  "assistant",
]);
export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
]);
export const outboxStatusEnum = pgEnum("outbox_status", ["pending", "published"]);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userSubjectId: uuid("user_subject_id")
      .notNull()
      .references(() => users.subjectId, { onDelete: "restrict" }),
    agentSubjectId: uuid("agent_subject_id")
      .notNull()
      .references(() => agents.subjectId, { onDelete: "restrict" }),
    title: varchar("title", { length: 200 }).default("New conversation").notNull(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("conversations_user_updated_idx").on(table.userSubjectId, table.updatedAt),
    index("conversations_agent_idx").on(table.agentSubjectId),
  ],
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "restrict" }),
    role: conversationMessageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("conversation_messages_conversation_created_idx").on(table.conversationId, table.createdAt)],
);

export type AgentRunUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "restrict" }),
    requestedBySubjectId: uuid("requested_by_subject_id")
      .notNull()
      .references(() => users.subjectId, { onDelete: "restrict" }),
    agentSubjectId: uuid("agent_subject_id")
      .notNull()
      .references(() => agents.subjectId, { onDelete: "restrict" }),
    modelProfileId: uuid("model_profile_id")
      .notNull()
      .references(() => modelProfiles.id, { onDelete: "restrict" }),
    userMessageId: uuid("user_message_id")
      .notNull()
      .references(() => conversationMessages.id, { onDelete: "restrict" }),
    assistantMessageId: uuid("assistant_message_id").references(() => conversationMessages.id, {
      onDelete: "restrict",
    }),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    status: agentRunStatusEnum("status").default("queued").notNull(),
    attempt: integer("attempt").default(0).notNull(),
    executionSnapshot: jsonb("execution_snapshot").$type<Record<string, unknown>>().notNull(),
    usage: jsonb("usage").$type<AgentRunUsage>(),
    finishReason: varchar("finish_reason", { length: 64 }),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: varchar("error_message", { length: 240 }),
    queuedAt: timestamp("queued_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("agent_runs_request_idempotency_uidx").on(
      table.requestedBySubjectId,
      table.idempotencyKey,
    ),
    uniqueIndex("agent_runs_user_message_uidx").on(table.userMessageId),
    uniqueIndex("agent_runs_assistant_message_uidx").on(table.assistantMessageId),
    uniqueIndex("agent_runs_one_active_per_conversation_uidx")
      .on(table.conversationId)
      .where(sql`${table.status} in ('queued', 'running')`),
    index("agent_runs_conversation_created_idx").on(table.conversationId, table.createdAt),
    index("agent_runs_status_queued_idx").on(table.status, table.queuedAt),
    check("agent_runs_attempt_check", sql`${table.attempt} >= 0 and ${table.attempt} <= 2`),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id").references(() => agentRuns.id, { onDelete: "cascade" }),
    modelCheckId: uuid("model_check_id").references(() => modelChecks.id, {
      onDelete: "cascade",
    }),
    topic: varchar("topic", { length: 100 }).notNull(),
    deduplicationKey: varchar("deduplication_key", { length: 128 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: outboxStatusEnum("status").default("pending").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: varchar("locked_by", { length: 128 }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("outbox_events_deduplication_uidx").on(table.deduplicationKey),
    index("outbox_events_dispatch_idx").on(table.status, table.availableAt),
    check(
      "outbox_events_single_owner_check",
      sql`(${table.runId} is null) <> (${table.modelCheckId} is null)`,
    ),
    check("outbox_events_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

export const agentRunEvents = pgTable(
  "agent_run_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventId: varchar("event_id", { length: 128 }).notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    attempt: integer("attempt").default(1).notNull(),
    type: varchar("type", { length: 100 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("agent_run_events_event_id_uidx").on(table.eventId),
    index("agent_run_events_run_attempt_sequence_idx").on(
      table.runId,
      table.attempt,
      table.sequence,
    ),
    index("agent_run_events_run_id_idx").on(table.runId, table.id),
    check("agent_run_events_sequence_check", sql`${table.sequence} >= 0`),
    check("agent_run_events_attempt_check", sql`${table.attempt} >= 1 and ${table.attempt} <= 2`),
  ],
);
