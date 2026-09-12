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
import type { CapabilitySchemaOverride } from "../capabilities/capability.registry";
import type { CapabilitySource } from "../capabilities/capability.source";
import { CapabilitySourceRegistry } from "../capabilities/capability-source.registry";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import { mcpServers, mcpTools, permissions } from "../database/schema";
import {
  McpClientError,
  McpClientService,
  type McpEndpointConfig,
} from "./mcp-client.service";
import {
  claimsMcpCapabilityNamespace,
  createJsonSchemaValidator,
  deriveMcpCapabilityId,
  deriveMcpModule,
  jsonValueSchema,
  MCP_TOOL_CAPABILITY_VERSION,
  validateDiscoveredToolName,
  type McpSyncErrorCode,
  type McpToolActivationState,
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
export class McpService implements OnApplicationBootstrap, CapabilitySource {
  private readonly logger = new Logger(McpService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly client: McpClientService,
    private readonly registry: CapabilityRegistry,
    private readonly sources: CapabilitySourceRegistry,
  ) {}

  /** Register enabled tools of active servers so governed runs can use them. */
  async onApplicationBootstrap(): Promise<void> {
    // Announced before the (best-effort) warm-up below: even if that fails, this
    // instance must still be able to resolve a tool capability on demand.
    this.sources.register(this);
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
    const removed = await this.database.db.transaction(async (tx) => {
      const rows = await tx
        .delete(mcpServers)
        .where(eq(mcpServers.id, id))
        .returning({ id: mcpServers.id, slug: mcpServers.slug });
      const deleted = rows[0];
      if (!deleted) throw new NotFoundException("MCP server not found");
      await this.audit.record(
        {
          ...actor,
          action: "mcp.server.deleted",
          resourceType: "mcp_server",
          resourceId: id,
          outcome: "success",
          metadata: { slug: deleted.slug },
        },
        tx,
      );
      return deleted;
    });
    // The slug must come from the deleting transaction: the row is already gone,
    // so re-reading it by id would find nothing and silently skip the registry
    // sweep, leaving this instance serving a deleted server's cached registrations.
    await this.unregisterServerCapabilities(removed.slug);
    this.client.invalidate(removed.id);
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
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    const server = servers[0];
    if (!server) throw new NotFoundException("MCP server not found");
    const tools = await this.database.db
      .select()
      .from(mcpTools)
      .where(eq(mcpTools.serverId, serverId))
      .orderBy(mcpTools.name);
    const knownPermissions = await this.loadKnownPermissions();
    return {
      items: tools.map((tool) =>
        this.serializeTool(tool, this.resolveToolActivation(server, tool, knownPermissions)),
      ),
    };
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

    // One catalog read serves both the registration pass and the activation
    // report returned to the admin.
    // Availability below describes THIS instance's registry, which is the only
    // registry this process can observe or serve capability requests from.
    const knownPermissions = await this.loadKnownPermissions();
    await this.registerServerTools(row.server, knownPermissions);
    return this.serializeTool(
      updated,
      this.resolveToolActivation(row.server, updated, knownPermissions),
    );
  }

  /**
   * Reconciles this process's registry with the stored rows for one server.
   * Runs after every server or tool mutation: eligible tools are registered
   * from scratch, so the warm registry mirrors what `load` would build on demand.
   */
  private async registerServerTools(
    server: McpServerRow,
    preloadedPermissions?: Set<string>,
  ): Promise<void> {
    await this.unregisterServerCapabilities(server.slug);

    if (server.status !== "active") return;
    const eligible = await this.database.db
      .select()
      .from(mcpTools)
      .where(and(eq(mcpTools.serverId, server.id), eq(mcpTools.enabled, true)));
    if (!eligible.length) return;

    const knownPermissions = preloadedPermissions ?? (await this.loadKnownPermissions());
    for (const tool of eligible) {
      const capabilityId = deriveMcpCapabilityId(server.slug, tool.name);
      if (!capabilityId) continue;
      if (!tool.requiredPermissions.length) continue;
      if (!tool.requiredPermissions.every((permission) => knownPermissions.has(permission))) {
        continue;
      }
      try {
        this.registry.register(
          this.buildCapabilityDefinition(server, tool, capabilityId),
          {
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema ?? {},
          },
        );
      } catch {
        // A duplicate id means another capability already owns it; leave the tool
        // unregistered rather than overriding an existing definition. The lazy
        // source resolves by id, so this instance would refuse calls for it too.
        this.logger.error(
          `MCP tool capability registration skipped for ${capabilityId}`,
        );
      }
    }
  }

  /**
   * CapabilitySource.claims. Decided without the database on purpose: every id
   * under the reserved `mcp-` prefix is ours to answer for, whether or not any
   * row still backs it. Claiming by row alone would let a deleted server escape
   * the fail-closed path — rows disappear, the prefix does not — and a cached
   * definition of a deleted server would go right on executing.
   */
  async claims(capabilityId: string): Promise<boolean> {
    return claimsMcpCapabilityNamespace(capabilityId);
  }

  /**
   * CapabilitySource.load. Builds a tool's capability straight from the
   * database, so a request served by an instance that never registered the
   * tool — one that booted before it was enabled, or another replica — gets
   * the same definition the current rows describe, reflecting admin intent
   * (endpoint, risk, required permissions) rather than boot-time state.
   *
   * Deliberately read-through rather than cached: the registry already caches
   * the built definition, and a second cache would need its own invalidation on
   * every mutation. The catalog reads (enabled tools joined with active servers,
   * plus the permission catalog) are full scans — acceptable at tool-registry
   * scale next to the model call each lookup feeds; revisit with a derived
   * capability-id column if registries grow large.
   */
  async load(
    capabilityId: string,
  ): Promise<{ definition: RegisteredCapability; schemas: CapabilitySchemaOverride } | null> {
    const rows = await this.database.db
      .select({ server: mcpServers, tool: mcpTools })
      .from(mcpTools)
      .innerJoin(mcpServers, eq(mcpTools.serverId, mcpServers.id))
      .where(and(eq(mcpTools.enabled, true), eq(mcpServers.status, "active")));
    const entry = rows.find(
      (row) => deriveMcpCapabilityId(row.server.slug, row.tool.name) === capabilityId,
    );
    if (!entry) return null;
    const { server, tool } = entry;
    if (!tool.requiredPermissions.length) return null;
    const knownPermissions = await this.loadKnownPermissions();
    if (!tool.requiredPermissions.every((permission) => knownPermissions.has(permission))) {
      return null;
    }
    try {
      return {
        definition: this.buildCapabilityDefinition(server, tool, capabilityId),
        schemas: { inputSchema: tool.inputSchema, outputSchema: tool.outputSchema ?? {} },
      };
    } catch {
      // A manifest that cannot be built (for example an invalid risk value) must
      // read as "not available" rather than failing the run with a raw error.
      return null;
    }
  }

  /**
   * Whether a governed run can actually call this tool. `enabled` is admin
   * intent; this is the effective availability the executor enforces.
   *
   * Registration is no longer a per-instance lottery: any instance resolves a
   * missing capability from the database on demand (see load), so a tool whose
   * preconditions hold is callable on every replica. This method therefore
   * reports the preconditions, and lets the registry answer what is currently
   * loaded here.
   */
  private resolveToolActivation(
    server: McpServerRow,
    tool: McpToolRow,
    knownPermissions: Set<string>,
  ): McpToolActivationState {
    const capabilityId = deriveMcpCapabilityId(server.slug, tool.name);
    return resolveToolActivationState({
      serverStatus: server.status,
      enabled: tool.enabled,
      capabilityId,
      requiredPermissions: tool.requiredPermissions,
      knownPermissions,
      registered: capabilityId ? this.registry.get(capabilityId) !== undefined : false,
    });
  }

  /** Known permissions, loaded once per request rather than once per tool. */
  private async loadKnownPermissions(): Promise<Set<string>> {
    const rows = await this.database.db
      .select({ resource: permissions.resource, action: permissions.action })
      .from(permissions);
    return new Set(rows.map((row) => `${row.resource}:${row.action}`));
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

  /**
   * Evicts every capability of this server from this process's registry.
   *
   * Swept by module ownership: the executor registers lazily-resolved
   * capabilities directly, so no bookkeeping list can be authoritative. A cached
   * manifest carries the requiredPermissions that execution authorizes against,
   * so leaving one behind would let a disabled or tightened tool keep running
   * here. The slug must be supplied by the caller — the deleting transaction is
   * the last place it is readable (see remove).
   */
  private async unregisterServerCapabilities(slug: string): Promise<void> {
    const module = deriveMcpModule(slug);
    for (const descriptor of this.registry.list()) {
      // Ownership-guarded: another module's capability can never be evicted.
      this.registry.unregister(descriptor.id, { module });
    }
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

  private serializeTool(tool: McpToolRow, activation: McpToolActivationState) {
    return {
      id: tool.id,
      serverId: tool.serverId,
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      requiredPermissions: tool.requiredPermissions,
      enabled: tool.enabled,
      /**
       * Effective availability, not admin intent: "registered" means a governed
       * run can actually call this tool. Any other value on an enabled tool is a
       * precondition the admin still has to satisfy.
       */
      activation,
      createdAt: tool.createdAt.toISOString(),
      updatedAt: tool.updatedAt.toISOString(),
    };
  }
}

export interface ToolActivationFacts {
  serverStatus: McpServerRow["status"];
  enabled: boolean;
  /** Null when the tool name cannot form a governed capability id. */
  capabilityId: string | null;
  requiredPermissions: string[];
  /** The permission catalog as currently stored. */
  knownPermissions: Set<string>;
  /** Whether this instance's registry currently holds the capability. */
  registered: boolean;
}

/**
 * The activation state machine, kept pure so every branch is directly testable
 * and so the only inputs are facts the caller can actually observe. "registered"
 * is the sole usable state; "disabled" is the admin's own switch; the rest mean
 * an enabled tool cannot reach the model.
 */
export function resolveToolActivationState(
  facts: ToolActivationFacts,
): McpToolActivationState {
  if (!facts.enabled) return "disabled";
  if (facts.serverStatus !== "active") return "server_disabled";
  if (!facts.capabilityId) return "invalid_capability_id";
  if (!facts.requiredPermissions.length) return "permissions_required";
  if (!facts.requiredPermissions.every((permission) => facts.knownPermissions.has(permission))) {
    return "unknown_permissions";
  }
  if (facts.registered) return "registered";
  // Every precondition holds, yet this instance has not loaded it. That is not a
  // permanent state: the executor resolves a miss on demand, so the next call
  // registers it. Reported as pending rather than registered because "loaded
  // here, now" is what the admin is being told.
  return "registration_pending";
}
