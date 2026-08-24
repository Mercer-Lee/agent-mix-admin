import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { timestamps } from "./common";
import { subjects } from "./subjects";

export const roles = pgTable(
  "roles",
  {
    subjectId: uuid("subject_id")
      .primaryKey()
      .references(() => subjects.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 64 }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description").default("").notNull(),
    isSystem: boolean("is_system").default(false).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("roles_key_uidx").on(table.key)],
);

export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    resource: varchar("resource", { length: 64 }).notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    description: text("description").default("").notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("permissions_resource_action_uidx").on(table.resource, table.action)],
);

export const subjectRoles = pgTable(
  "subject_roles",
  {
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.subjectId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.subjectId, table.roleId] }),
    index("subject_roles_role_idx").on(table.roleId),
    check("subject_roles_no_self_check", sql`${table.subjectId} <> ${table.roleId}`),
  ],
);

export const subjectPermissions = pgTable(
  "subject_permissions",
  {
    subjectId: uuid("subject_id")
      .notNull()
      .references(() => subjects.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.subjectId, table.permissionId] }),
    index("subject_permissions_permission_idx").on(table.permissionId),
  ],
);
