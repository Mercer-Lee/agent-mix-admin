import { sql } from "drizzle-orm";
import { check, pgTable, text, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

import { timestamps } from "./common";
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
    ...timestamps,
  },
  (table) => [
    uniqueIndex("agents_slug_uidx").on(table.slug),
    check("agents_slug_format_check", sql`${table.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
  ],
);
