import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { and, count, eq, inArray } from "drizzle-orm";
import { CapabilityManifestSchema } from "@agentmix/core";
import type { RegisteredCapability } from "../capabilities/capability.types";
import { CapabilityRegistry } from "../capabilities/capability.registry";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import { mcpServers, mcpTools, permissions } from "../database/schema";
import {
  McpClientError,
  McpClientService,
  type McpEndpointConfig,
} from "./mcp-client.service";
import {
  createJsonSchemaValidator,
  deriveMcpCapabilityId,
  deriveMcpModule,
  jsonValueSchema,
  MCP_TOOL_CAPABILITY_VERSION,
  validateDiscoveredToolName,
  type McpSyncErrorCode,
  type McpToolRejectionReason,
} from "./mcp.tooling";
import type { CreateMcpServerDto } from "./dto/create-mcp-server.dto";
import type { UpdateMcpServerDto } from "./dto/update-mcp-server.dto";
import type { UpdateMcpToolDto } from "./dto/update-mcp-tool.dto";

interface ActorMetadata {
  actorSubjectId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

type McpServerRow = typeof mcpServers.$inferSelect;
type McpToolRow = typeof mcpTools.$inferSelect;

interface SyncOutcome {
  added: number;
  updated: number;
  removed: string[];
  rejected: Array<{ name: string; reason: McpToolRejectionReason }>;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "23505") return true;
  return "cause" in error && isUniqueViolation(error.cause);
}

@Injectable()
export class McpService implements OnApplicationBootstrap {
  private readonly logger = new Logger(McpService.name);
  /**
   * Capabilities this service registered into the registry, keyed by server id.
   * The module is recorded alongside each id so removal can prove ownership.
   */
  private readonly registeredCapabilities = new Map<
    string,
    Array<{ id: string; module: string }>
  >();

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly client: McpClientService,
    private readonly registry: CapabilityRegistry,
  ) {}

  /** Register enabled tools of active servers so governed runs can use them. */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const servers = await this.database.db.select().from(mcpServers);
      for (const server of servers) {
        await this.registerServerTools(server);
      }
    } catch {
      // Registration is best-effort at boot: the control plane stays reachable
      // for governance reads and the next sync retries. Never log the cause —
      // SQL errors can embed row payloads.
      this.logger.error("MCP capability registration at boot failed");
    }
  }

  async list() {
    const servers = await this.database.db
      .select()
      .from(mcpServers)
      .orderBy(mcpServers.name);
    const toolCounts = servers.length
      ? await this.database.db
          .select({ serverId: mcpTools.serverId, total: count() })
          .from(mcpTools)
          .where(
            inArray(
              mcpTools.serverId,
              servers.map((server) => server.id),
            ),
          )
          .groupBy(mcpTools.serverId)
      : [];
    const counts = new Map(
      toolCounts.map((row) => [row.serverId, Number(row.total)]),
    );
    return {
      items: servers.map((server) =>
        this.serializeServer(server, counts.get(server.id) ?? 0),
      ),
    };
  }

  async create(dto: CreateMcpServerDto, actor: ActorMetadata) {
    if (Boolean(dto.authHeaderName) !== Boolean(dto.authEnvVar)) {
      throw new BadRequestException(
        "authHeaderName and authEnvVar must be provided together",
      );
    }
    try {
      const server = await this.database.db.transaction(async (tx) => {
        const rows = await tx
          .insert(mcpServers)
          .values({
            slug: dto.slug,
            name: dto.name,
            description: dto.description,
            endpointUrl: dto.endpointUrl,
            authHeaderName: dto.authHeaderName ?? null,
            authEnvVar: dto.authEnvVar ?? null,
            status: dto.status,
          })
          .returning();
        const created = rows[0]!;
        await this.audit.record(
          {
            ...actor,
            action: "mcp.server.created",
            resourceType: "mcp_server",
            resourceId: created.id,
            outcome: "success",
            metadata: {
              slug: created.slug,
              status: created.status,
              hasAuth: Boolean(created.authEnvVar),
            },
          },
          tx,
        );
        return created;
      });
      return this.serializeServer(server, 0);
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException("MCP server slug already exists");
      throw error;
    }
  }

  async update(id: string, dto: UpdateMcpServerDto, actor: ActorMetadata) {
    if (dto.clearAuth && dto.authHeaderName !== undefined) {
      throw new BadRequestException(
        "clearAuth cannot be combined with authHeaderName",
      );
    }
    const server = await this.database.db.transaction(async (tx) => {
      const current = await tx
        .select({
          authHeaderName: mcpServers.authHeaderName,
          authEnvVar: mcpServers.authEnvVar,
        })
        .from(mcpServers)
        .where(eq(mcpServers.id, id))
        .limit(1);
      if (!current[0]) throw new NotFoundException("MCP server not found");
      if (dto.authHeaderName === undefined && dto.authEnvVar !== undefined) {
        throw new BadRequestException(
          "authHeaderName is required when authEnvVar is provided",
        );
      }
      if (dto.clearAuth && !current[0].authHeaderName) {
        throw new BadRequestException("This MCP server has no stored credentials");
      }
      // Omitted fields keep their stored value; clearAuth is the only way to
      // end up with a null pair, so a partial update can never strip auth.
      const mergedHeader = dto.clearAuth
        ? null
        : (dto.authHeaderName ?? current[0].authHeaderName);
      const mergedEnvVar = dto.clearAuth
        ? null
        : (dto.authEnvVar ?? current[0].authEnvVar);
      if (Boolean(mergedHeader) !== Boolean(mergedEnvVar)) {
        throw new BadRequestException(
          "authHeaderName and authEnvVar must be updated together",
        );
      }
      const rows = await tx
        .update(mcpServers)
        .set({
          ...(dto.name === undefined ? {} : { name: dto.name }),
          ...(dto.description === undefined
            ? {}
            : { description: dto.description }),
          ...(dto.endpointUrl === undefined
            ? {}
            : { endpointUrl: dto.endpointUrl }),
          ...(dto.clearAuth
            ? { authHeaderName: null, authEnvVar: null }
            : {
                ...(dto.authHeaderName === undefined
                  ? {}
                  : { authHeaderName: dto.authHeaderName }),
                ...(dto.authEnvVar === undefined
                  ? {}
                  : { authEnvVar: dto.authEnvVar }),
              }),
          ...(dto.status === undefined ? {} : { status: dto.status }),
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, id))
        .returning();
      const updated = rows[0];
      if (!updated) throw new NotFoundException("MCP server not found");
      await this.audit.record(
        {
          ...actor,
          action: "mcp.server.updated",
          resourceType: "mcp_server",
          resourceId: id,
          outcome: "success",
          metadata: {
            status: updated.status,
            hasAuth: Boolean(updated.authEnvVar),
            authChanged:
              dto.clearAuth === true ||
              dto.authHeaderName !== undefined ||
              dto.authEnvVar !== undefined,
          },
        },
        tx,
      );
      return updated;
    });
    if (
      dto.endpointUrl !== undefined ||
      dto.authHeaderName !== undefined ||
      dto.authEnvVar !== undefined ||
      dto.clearAuth === true
    ) {
      this.client.invalidate(id);
    }
    await this.registerServerTools(server);
    return this.serializeServer(server, await this.toolCount(id));
  }

  async remove(id: string, actor: ActorMetadata) {
    await this.database.db.transaction(async (tx) => {
      const rows = await tx
        .delete(mcpServers)
        .where(eq(mcpServers.id, id))
        .returning({ id: mcpServers.id, slug: mcpServers.slug });
      const removed = rows[0];
      if (!removed) throw new NotFoundException("MCP server not found");
      await this.audit.record(
        {
          ...actor,
          action: "mcp.server.deleted",
          resourceType: "mcp_server",
          resourceId: id,
          outcome: "success",
          metadata: { slug: removed.slug },
        },
        tx,
      );
    });
    await this.unregisterServerCapabilities(id);
    this.client.invalidate(id);
  }

  /**
   * Discover the remote tool list and reconcile stored tools. Discovery-owned
   * fields (description, schemas) are overwritten; admin-owned fields (risk,
   * requiredPermissions, enabled) are preserved. Tools that disappeared are
   * deleted, which cascades their agent bindings.
   */
  async sync(id: string, actor: ActorMetadata): Promise<SyncOutcome> {
    const servers = await this.database.db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, id))
      .limit(1);
    const server = servers[0];
    if (!server) throw new NotFoundException("MCP server not found");
    if (server.status !== "active")
      throw new ConflictException("MCP server is disabled");

    try {
      const discovered = await this.client.listTools(this.endpointOf(server));
      // Tools whose names cannot form a governed capability id are skipped
      // and reported instead of failing discovery for the whole server.
      const seenIds = new Map<string, string>();
      const rejected: SyncOutcome["rejected"] = [];
      const accepted = discovered.filter((tool) => {
        const capabilityId = deriveMcpCapabilityId(server.slug, tool.name);
        if (!validateDiscoveredToolName(tool.name) || !capabilityId) {
          rejected.push({ name: tool.name, reason: "TOOL_NAME_INVALID" });
          return false;
        }
        const conflicting = seenIds.get(capabilityId);
        if (conflicting && conflicting !== tool.name) {
          rejected.push({ name: tool.name, reason: "TOOL_NAME_CONFLICT" });
          return false;
        }
        seenIds.set(capabilityId, tool.name);
        return true;
      });

      let outcome: SyncOutcome;
      try {
        outcome = await this.database.db.transaction(async (tx) => {
          const existingRows = await tx
            .select()
            .from(mcpTools)
            .where(eq(mcpTools.serverId, id));
          const existingByName = new Map(
            existingRows.map((row) => [row.name, row]),
          );
          const discoveredNames = new Set(accepted.map((tool) => tool.name));
          const removed = existingRows
            .filter((row) => !discoveredNames.has(row.name))
            .map((row) => row.name);
          if (removed.length) {
            await tx
              .delete(mcpTools)
              .where(
                and(eq(mcpTools.serverId, id), inArray(mcpTools.name, removed)),
              );
          }
          let added = 0;
          let updated = 0;
          for (const tool of accepted) {
            const existing = existingByName.get(tool.name);
            if (!existing) {
              await tx.insert(mcpTools).values({
                serverId: id,
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
                outputSchema: tool.outputSchema,
                risk: "read",
                requiredPermissions: [],
                enabled: false,
              });
              added += 1;
              continue;
            }
            const discoveryChanged =
              existing.description !== tool.description ||
              JSON.stringify(existing.inputSchema) !==
                JSON.stringify(tool.inputSchema) ||
              JSON.stringify(existing.outputSchema ?? null) !==
                JSON.stringify(tool.outputSchema);
            if (discoveryChanged) {
              await tx
                .update(mcpTools)
                .set({
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                  outputSchema: tool.outputSchema,
                  updatedAt: new Date(),
                })
                .where(eq(mcpTools.id, existing.id));
              updated += 1;
            }
          }
          await tx
            .update(mcpServers)
            .set({
              lastSyncedAt: new Date(),
              lastSyncErrorCode: null,
              updatedAt: new Date(),
            })
            .where(eq(mcpServers.id, id));
          await this.audit.record(
            {
              ...actor,
              action: "mcp.server.synced",
              resourceType: "mcp_server",
              resourceId: id,
              outcome: "success",
              metadata: {
                added,
                updated,
                removedCount: removed.length,
                discoveredCount: discovered.length,
                rejectedCount: rejected.length,
              },
            },
            tx,
          );
          return { added, updated, removed, rejected };
        });
      } catch (error) {
        // Two concurrent syncs of the same server collide on the tool unique
        // key; the losing one retries deliberately instead of surfacing 502.
        if (isUniqueViolation(error))
          throw new ConflictException("Sync conflict, retry the tool sync");
        throw error;
      }

      await this.registerServerTools(server);
      return outcome;
    } catch (error) {
      const errorCode: McpSyncErrorCode =
        error instanceof McpClientError ? error.code : "PROTOCOL_ERROR";
      await this.database.db
        .update(mcpServers)
        .set({ lastSyncErrorCode: errorCode, updatedAt: new Date() })
        .where(eq(mcpServers.id, id));
      await this.audit.record({
        ...actor,
        action: "mcp.server.sync.failed",
        resourceType: "mcp_server",
        resourceId: id,
        outcome: "failure",
        metadata: { errorCode },
      });
      throw new HttpException(`MCP tool sync failed (${errorCode})`, 502);
    }
  }

  async listTools(serverId: string) {
    const servers = await this.database.db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    if (!servers[0]) throw new NotFoundException("MCP server not found");
    const tools = await this.database.db
      .select()
      .from(mcpTools)
      .where(eq(mcpTools.serverId, serverId))
      .orderBy(mcpTools.name);
    return { items: tools.map((tool) => this.serializeTool(tool)) };
  }

  async updateTool(
    toolId: string,
    dto: UpdateMcpToolDto,
    actor: ActorMetadata,
  ) {
    const rows = await this.database.db
      .select({ tool: mcpTools, server: mcpServers })
      .from(mcpTools)
      .innerJoin(mcpServers, eq(mcpTools.serverId, mcpServers.id))
      .where(eq(mcpTools.id, toolId))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("MCP tool not found");

    if (dto.requiredPermissions !== undefined) {
      await this.assertPermissionsExist(dto.requiredPermissions);
    }
    const nextEnabled = dto.enabled ?? row.tool.enabled;
    const nextPermissions =
      dto.requiredPermissions ?? row.tool.requiredPermissions;
    if (nextEnabled && nextPermissions.length === 0) {
      throw new ConflictException(
        "An MCP tool needs at least one required permission before it can be enabled",
      );
    }

    const updated = await this.database.db.transaction(async (tx) => {
      const result = await tx
        .update(mcpTools)
        .set({
          ...(dto.risk === undefined ? {} : { risk: dto.risk }),
          ...(dto.requiredPermissions === undefined
            ? {}
            : { requiredPermissions: dto.requiredPermissions }),
          ...(dto.enabled === undefined ? {} : { enabled: dto.enabled }),
          updatedAt: new Date(),
        })
        .where(eq(mcpTools.id, toolId))
        .returning();
      const tool = result[0]!;
      await this.audit.record(
        {
          ...actor,
          action: "mcp.tool.updated",
          resourceType: "mcp_tool",
          resourceId: toolId,
          outcome: "success",
          metadata: {
            name: tool.name,
            risk: tool.risk,
            enabled: tool.enabled,
            requiredPermissions: tool.requiredPermissions,
          },
        },
        tx,
      );
      return tool;
    });

    await this.registerServerTools(row.server);
    return this.serializeTool(updated);
  }

  private async registerServerTools(server: McpServerRow): Promise<void> {
    await this.unregisterServerCapabilities(server.id);
    if (server.status !== "active") return;

    const tools = await this.database.db
      .select()
      .from(mcpTools)
      .where(and(eq(mcpTools.serverId, server.id), eq(mcpTools.enabled, true)));
    if (!tools.length) return;

    const permissionRows = await this.database.db
      .select({ resource: permissions.resource, action: permissions.action })
      .from(permissions);
    const knownPermissions = new Set(
      permissionRows.map(
        (permission) => `${permission.resource}:${permission.action}`,
      ),
    );

    const registered: Array<{ id: string; module: string }> = [];
    for (const tool of tools) {
      const capabilityId = deriveMcpCapabilityId(server.slug, tool.name);
      if (!capabilityId) continue;
      if (!tool.requiredPermissions.length) continue;
      if (
        !tool.requiredPermissions.every((permission) =>
          knownPermissions.has(permission),
        )
      )
        continue;
      try {
        this.registry.register(
          this.buildCapabilityDefinition(server, tool, capabilityId),
          {
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema ?? {},
          },
        );
        registered.push({ id: capabilityId, module: deriveMcpModule(server.slug) });
      } catch {
        // A duplicate id means another capability already owns it; leave the
        // tool unregistered rather than overriding an existing definition.
        this.logger.error(
          `MCP tool capability registration skipped for ${capabilityId}`,
        );
      }
    }
    this.registeredCapabilities.set(server.id, registered);
  }

  private buildCapabilityDefinition(
    server: McpServerRow,
    tool: McpToolRow,
    capabilityId: string,
  ): RegisteredCapability {
    const manifest = CapabilityManifestSchema.parse({
      id: capabilityId,
      version: MCP_TOOL_CAPABILITY_VERSION,
      module: deriveMcpModule(server.slug),
      description: tool.description || tool.name,
      risk: tool.risk,
      requiredPermissions: tool.requiredPermissions,
    });
    return {
      manifest,
      inputSchema: createJsonSchemaValidator(tool.inputSchema),
      outputSchema: tool.outputSchema
        ? createJsonSchemaValidator(tool.outputSchema)
        : jsonValueSchema,
      execute: async (input: unknown) =>
        this.client.callTool(this.endpointOf(server), tool.name, input),
    };
  }

  private async unregisterServerCapabilities(serverId: string): Promise<void> {
    const registered = this.registeredCapabilities.get(serverId);
    if (!registered) return;
    for (const capability of registered) {
      // Ownership-guarded: an instance that lost a registration race must not
      // evict the live capability another owner registered under the same id.
      this.registry.unregister(capability.id, { module: capability.module });
    }
    this.registeredCapabilities.delete(serverId);
  }

  private endpointOf(server: McpServerRow): McpEndpointConfig {
    return {
      serverId: server.id,
      endpointUrl: server.endpointUrl,
      authHeaderName: server.authHeaderName,
      authEnvVar: server.authEnvVar,
    };
  }

  private async assertPermissionsExist(
    requiredPermissions: string[],
  ): Promise<void> {
    if (!requiredPermissions.length) return;
    const rows = await this.database.db
      .select({ resource: permissions.resource, action: permissions.action })
      .from(permissions);
    const known = new Set(rows.map((row) => `${row.resource}:${row.action}`));
    const missing = requiredPermissions.filter(
      (permission) => !known.has(permission),
    );
    if (missing.length) {
      throw new ConflictException(`Unknown permissions: ${missing.join(", ")}`);
    }
  }

  private async toolCount(serverId: string): Promise<number> {
    const rows = await this.database.db
      .select({ total: count() })
      .from(mcpTools)
      .where(eq(mcpTools.serverId, serverId));
    return Number(rows[0]?.total ?? 0);
  }

  private serializeServer(server: McpServerRow, toolCount: number) {
    return {
      id: server.id,
      slug: server.slug,
      name: server.name,
      description: server.description,
      endpointUrl: server.endpointUrl,
      hasAuth: Boolean(server.authHeaderName && server.authEnvVar),
      // The env var *name* is configuration, not a credential: the admin form
      // shows it so an operator knows which variable backs this server's auth.
      authEnvVar: server.authEnvVar,
      status: server.status,
      toolCount,
      lastSyncedAt: server.lastSyncedAt?.toISOString() ?? null,
      lastSyncErrorCode: server.lastSyncErrorCode,
      createdAt: server.createdAt.toISOString(),
      updatedAt: server.updatedAt.toISOString(),
    };
  }

  private serializeTool(tool: McpToolRow) {
    return {
      id: tool.id,
      serverId: tool.serverId,
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      requiredPermissions: tool.requiredPermissions,
      enabled: tool.enabled,
      createdAt: tool.createdAt.toISOString(),
      updatedAt: tool.updatedAt.toISOString(),
    };
  }
}
