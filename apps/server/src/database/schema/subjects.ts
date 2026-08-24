import { index, pgEnum, pgTable, uuid } from "drizzle-orm/pg-core";

import { timestamps } from "./common";

export const subjectTypeEnum = pgEnum("subject_type", ["user", "role", "agent"]);
export const subjectStatusEnum = pgEnum("subject_status", ["active", "disabled"]);

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
