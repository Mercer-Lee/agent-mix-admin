import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { timestamps } from "./common";
import { subjects } from "./subjects";

export const departmentStatusEnum = pgEnum("department_status", ["active", "disabled"]);

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
