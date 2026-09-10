import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { timestamps } from "./common";
import { agents } from "./agents";
import { subjects } from "./subjects";

export const mcpServerStatusEnum = pgEnum("mcp_server_status", ["active", "disabled"]);

/** Mirrors CapabilityRiskSchema from @agentmix/core so descriptors round-trip. */
export const mcpToolRiskEnum = pgEnum("mcp_tool_risk", [
  "read",
  "sensitive_read",
  "write",
  "critical",
]);

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: varchar("slug", { length: 100 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description").default("").notNull(),
    endpointUrl: varchar("endpoint_url", { length: 2048 }).notNull(),
    /**
     * Auth credentials never live in the database: the header name and the
     * environment variable that holds the secret value are stored instead, and
     * the value is resolved from the server process environment at connect time.
     */
    authHeaderName: varchar("auth_header_name", { length: 100 }),
    authEnvVar: varchar("auth_env_var", { length: 100 }),
    status: mcpServerStatusEnum("status").default("active").notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastSyncErrorCode: varchar("last_sync_error_code", { length: 64 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("mcp_servers_slug_uidx").on(table.slug),
    check("mcp_servers_slug_format_check", sql`${table.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
    check("mcp_servers_endpoint_url_check", sql`${table.endpointUrl} ~ '^https?://'`),
    check(
      "mcp_servers_auth_pair_check",
      sql`(${table.authHeaderName} is null) = (${table.authEnvVar} is null)`,
    ),
  ],
);

export const mcpTools = pgTable(
  "mcp_tools",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 64 }).notNull(),
    description: text("description").default("").notNull(),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull(),
    outputSchema: jsonb("output_schema").$type<Record<string, unknown>>(),
    risk: mcpToolRiskEnum("risk").default("read").notNull(),
    requiredPermissions: jsonb("required_permissions").$type<string[]>().default([]).notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("mcp_tools_server_name_uidx").on(table.serverId, table.name),
    index("mcp_tools_enabled_idx").on(table.enabled),
    check("mcp_tools_name_format_check", sql`${table.name} ~ '^[a-zA-Z0-9_-]{1,64}$'`),
  ],
);

export const agentToolBindings = pgTable(
  "agent_tool_bindings",
  {
    agentSubjectId: uuid("agent_subject_id")
      .notNull()
      .references(() => agents.subjectId, { onDelete: "cascade" }),
    toolId: uuid("tool_id")
      .notNull()
      .references(() => mcpTools.id, { onDelete: "cascade" }),
    createdBySubjectId: uuid("created_by_subject_id").references(() => subjects.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.agentSubjectId, table.toolId] }),
    index("agent_tool_bindings_tool_idx").on(table.toolId),
  ],
);
