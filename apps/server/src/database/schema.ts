import { sql } from "drizzle-orm";
import {
  AnyPgColumn,
  boolean,
  check,
  index,
  integer,
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

export const subjectTypeEnum = pgEnum("subject_type", ["user", "role", "agent"]);
export const subjectStatusEnum = pgEnum("subject_status", ["active", "disabled"]);
export const departmentStatusEnum = pgEnum("department_status", ["active", "disabled"]);
export const auditOutcomeEnum = pgEnum("audit_outcome", ["success", "failure"]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const subjects = pgTable(
  "subjects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: subjectTypeEnum("type").notNull(),
    status: subjectStatusEnum("status").default("active").notNull(),
    ...timestamps,
  },
  (table) => [index("subjects_type_status_idx").on(table.type, table.status)],
);

export const departments = pgTable(
  "departments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    parentId: uuid("parent_id").references((): AnyPgColumn => departments.id, {
      onDelete: "restrict",
    }),
    code: varchar("code", { length: 64 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    sortOrder: integer("sort_order").default(0).notNull(),
    status: departmentStatusEnum("status").default("active").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("departments_code_uidx").on(table.code),
    index("departments_parent_idx").on(table.parentId),
  ],
);

export const users = pgTable(
  "users",
  {
    subjectId: uuid("subject_id")
      .primaryKey()
      .references(() => subjects.id, { onDelete: "cascade" }),
    departmentId: uuid("department_id").references(() => departments.id, { onDelete: "set null" }),
    username: varchar("username", { length: 32 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: varchar("display_name", { length: 80 }).notNull(),
    email: varchar("email", { length: 254 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("users_username_uidx").on(table.username),
    uniqueIndex("users_email_uidx").on(table.email),
    index("users_department_idx").on(table.departmentId),
    check("users_username_format_check", sql`${table.username} ~ '^[a-z0-9._-]{3,32}$'`),
  ],
);

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

export const agents = pgTable(
  "agents",
  {
    subjectId: uuid("subject_id")
      .primaryKey()
      .references(() => subjects.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 100 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    description: text("description").default("").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("agents_slug_uidx").on(table.slug),
    check("agents_slug_format_check", sql`${table.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
  ],
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

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userSubjectId: uuid("user_subject_id")
      .notNull()
      .references(() => users.subjectId, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_uidx").on(table.tokenHash),
    index("sessions_user_idx").on(table.userSubjectId),
    index("sessions_expiry_idx").on(table.expiresAt),
  ],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorSubjectId: uuid("actor_subject_id").references(() => subjects.id, { onDelete: "set null" }),
    action: varchar("action", { length: 100 }).notNull(),
    resourceType: varchar("resource_type", { length: 64 }).notNull(),
    resourceId: varchar("resource_id", { length: 128 }),
    outcome: auditOutcomeEnum("outcome").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_logs_actor_idx").on(table.actorSubjectId),
    index("audit_logs_action_idx").on(table.action),
    index("audit_logs_created_at_idx").on(table.createdAt),
  ],
);
