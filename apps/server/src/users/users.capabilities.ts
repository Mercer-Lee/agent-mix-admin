import { Injectable, OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { CapabilityRegistry } from "../capabilities/capability.registry";
import { defineCapability } from "../capabilities/capability.types";
import { UsersService } from "./users.service";

export const UsersSearchInputSchema = z
  .object({
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(20),
    search: z.string().trim().max(80).optional(),
  })
  .strict();

const DepartmentSummarySchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
});

const UserSummarySchema = z.object({
  id: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  status: z.enum(["active", "disabled"]),
  department: DepartmentSummarySchema.nullable(),
  createdAt: z.string().datetime(),
});

export const UsersSearchOutputSchema = z.object({
  items: z.array(UserSummarySchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1).max(100),
});

@Injectable()
export class UsersCapabilities implements OnModuleInit {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly users: UsersService,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      defineCapability({
        manifest: {
          id: "users.search",
          version: "1.0.0",
          module: "users",
          description: "Search and paginate users visible to the current user and agent",
          risk: "read",
          requiredPermissions: ["users:read"],
        },
        inputSchema: UsersSearchInputSchema,
        outputSchema: UsersSearchOutputSchema,
        execute: (input) => this.users.list(input),
        audit: {
          input: (input) => ({
            page: input.page,
            pageSize: input.pageSize,
            search: input.search ?? null,
          }),
          output: (output) => ({
            resultCount: output.items.length,
            total: output.total,
          }),
        },
      }),
    );
  }
}
