import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { timestamps } from "./common";
import { departments, users } from "./organization";
import { roles } from "./rbac";
import { subjects } from "./subjects";

export const agents = pgTable(
  "agents",
  {
    subjectId: uuid("subject_id")
      .primaryKey()
      .references(() => subjects.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 100 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description").default("").notNull(),
    isSystem: boolean("is_system").default(false).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("agents_slug_uidx").on(table.slug),
    check("agents_slug_format_check", sql`${table.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
  ],
);

export const agentUserAccessGrants = pgTable(
  "agent_user_access_grants",
  {
    agentSubjectId: uuid("agent_subject_id")
      .notNull()
      .references(() => agents.subjectId, { onDelete: "cascade" }),
    userSubjectId: uuid("user_subject_id")
      .notNull()
      .references(() => users.subjectId, { onDelete: "cascade" }),
    createdBySubjectId: uuid("created_by_subject_id").references(() => subjects.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.agentSubjectId, table.userSubjectId] }),
    index("agent_user_access_user_idx").on(table.userSubjectId),
  ],
);

export const agentRoleAccessGrants = pgTable(
  "agent_role_access_grants",
  {
    agentSubjectId: uuid("agent_subject_id")
      .notNull()
      .references(() => agents.subjectId, { onDelete: "cascade" }),
    roleSubjectId: uuid("role_subject_id")
      .notNull()
      .references(() => roles.subjectId, { onDelete: "cascade" }),
    createdBySubjectId: uuid("created_by_subject_id").references(() => subjects.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.agentSubjectId, table.roleSubjectId] }),
    index("agent_role_access_role_idx").on(table.roleSubjectId),
  ],
);

export const agentDepartmentAccessGrants = pgTable(
  "agent_department_access_grants",
  {
    agentSubjectId: uuid("agent_subject_id")
      .notNull()
      .references(() => agents.subjectId, { onDelete: "cascade" }),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => departments.id, { onDelete: "cascade" }),
    includeDescendants: boolean("include_descendants").default(false).notNull(),
    createdBySubjectId: uuid("created_by_subject_id").references(() => subjects.id, {
      onDelete: "set null",
    }),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.agentSubjectId, table.departmentId] }),
    index("agent_department_access_department_idx").on(table.departmentId),
  ],
);
