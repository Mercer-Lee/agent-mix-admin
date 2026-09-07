import { z } from "zod";

/** Input shared by the control-plane implementation and the Runtime tool bridge. */
export const UsersSearchInputV1Schema = z
  .object({
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(80).optional(),
  })
  .strict();

export const UsersSearchDepartmentV1Schema = z
  .object({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
  })
  .strict();

export const UsersSearchUserV1Schema = z
  .object({
    id: z.uuid(),
    username: z.string(),
    displayName: z.string(),
    email: z.string().nullable(),
    status: z.enum(["active", "disabled"]),
    department: UsersSearchDepartmentV1Schema.nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

/** Output shared by the control-plane implementation and the Runtime tool bridge. */
export const UsersSearchOutputV1Schema = z
  .object({
    items: z.array(UsersSearchUserV1Schema),
    total: z.number().int().min(0),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
  })
  .strict();

export type UsersSearchInputV1 = z.infer<typeof UsersSearchInputV1Schema>;
export type UsersSearchOutputV1 = z.infer<typeof UsersSearchOutputV1Schema>;

// The unversioned aliases make the Phase 1B server capability easy to migrate
// while all queue-facing contracts remain explicitly V1.
export const UsersSearchInputSchema = UsersSearchInputV1Schema;
export const UsersSearchOutputSchema = UsersSearchOutputV1Schema;
export type UsersSearchInput = UsersSearchInputV1;
export type UsersSearchOutput = UsersSearchOutputV1;
