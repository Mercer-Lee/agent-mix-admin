import { UsersSearchInputV1Schema, type RuntimeToolDescriptorV1 } from "@agentmix/core";
import { z } from "zod";

export const USERS_SEARCH_TOOL_ID = "users.search";
export const USERS_SEARCH_TOOL_NAME = "users_search";

/**
 * The users.search tool descriptor exposed to the model. Kept alongside the
 * capability definition so the snapshot contract (`tools`) stays the single
 * source the Worker builds its tool set from.
 */
export function buildUsersSearchToolDescriptor(): RuntimeToolDescriptorV1 {
  return {
    id: USERS_SEARCH_TOOL_ID,
    name: USERS_SEARCH_TOOL_NAME,
    description:
      "Search and paginate users that both the current user and Agent are authorized to read.",
    inputSchema: z.toJSONSchema(UsersSearchInputV1Schema) as Record<string, unknown>,
  };
}
