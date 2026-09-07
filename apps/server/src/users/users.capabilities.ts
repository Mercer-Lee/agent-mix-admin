import { Injectable, OnModuleInit } from "@nestjs/common";
import { UsersSearchInputV1Schema, UsersSearchOutputV1Schema } from "@agentmix/core";
import { CapabilityRegistry } from "../capabilities/capability.registry";
import { defineCapability } from "../capabilities/capability.types";
import { UsersService } from "./users.service";

export const UsersSearchInputSchema = UsersSearchInputV1Schema;
export const UsersSearchOutputSchema = UsersSearchOutputV1Schema;

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
            hasSearch: Boolean(input.search),
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
