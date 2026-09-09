import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  integer,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import { agents } from "./agents";
import { timestamps } from "./common";
import { modelProfiles } from "./models";

export const agentRuntimes = pgTable(
  "agent_runtimes",
  {
    agentSubjectId: uuid("agent_subject_id")
      .primaryKey()
      .references(() => agents.subjectId, { onDelete: "cascade" }),
    modelProfileId: uuid("model_profile_id")
      .notNull()
      .references(() => modelProfiles.id, { onDelete: "restrict" }),
    systemPrompt: text("system_prompt").default("").notNull(),
    temperature: doublePrecision("temperature").default(0.2).notNull(),
    maxOutputTokens: integer("max_output_tokens").default(2048).notNull(),
    maxSteps: integer("max_steps").default(5).notNull(),
    ...timestamps,
  },
  (table) => [
    check(
      "agent_runtimes_temperature_check",
      sql`${table.temperature} >= 0 and ${table.temperature} <= 2`,
    ),
    check(
      "agent_runtimes_max_output_tokens_check",
      sql`${table.maxOutputTokens} >= 1 and ${table.maxOutputTokens} <= 131072`,
    ),
    check("agent_runtimes_max_steps_check", sql`${table.maxSteps} >= 1 and ${table.maxSteps} <= 5`),
  ],
);
