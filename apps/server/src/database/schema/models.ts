import { sql } from "drizzle-orm";
import {
  boolean,
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

import { timestamps } from "./common";
import { subjects } from "./subjects";

export const modelProfileStatusEnum = pgEnum("model_profile_status", ["active", "disabled"]);
export const modelCheckStatusEnum = pgEnum("model_check_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
]);

export const modelProfiles = pgTable(
  "model_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: varchar("key", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description").default("").notNull(),
    provider: varchar("provider", { length: 32 }).default("openai-compatible").notNull(),
    connection: varchar("connection", { length: 32 }).default("default").notNull(),
    modelId: varchar("model_id", { length: 200 }).notNull(),
    status: modelProfileStatusEnum("status").default("active").notNull(),
    isSystem: boolean("is_system").default(false).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("model_profiles_key_uidx").on(table.key),
    check("model_profiles_key_format_check", sql`${table.key} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
    check("model_profiles_provider_check", sql`${table.provider} = 'openai-compatible'`),
    check("model_profiles_connection_check", sql`${table.connection} = 'default'`),
    check("model_profiles_model_id_check", sql`length(btrim(${table.modelId})) > 0`),
  ],
);

export type ModelCheckUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export const modelChecks = pgTable(
  "model_checks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    modelProfileId: uuid("model_profile_id")
      .notNull()
      .references(() => modelProfiles.id, { onDelete: "cascade" }),
    requestedBySubjectId: uuid("requested_by_subject_id").references(() => subjects.id, {
      onDelete: "set null",
    }),
    status: modelCheckStatusEnum("status").default("queued").notNull(),
    latencyMs: integer("latency_ms"),
    usage: jsonb("usage").$type<ModelCheckUsage>(),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: varchar("error_message", { length: 240 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("model_checks_profile_created_idx").on(table.modelProfileId, table.createdAt),
    check("model_checks_latency_check", sql`${table.latencyMs} is null or ${table.latencyMs} >= 0`),
  ],
);
