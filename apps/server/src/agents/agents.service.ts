import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import type { CapabilityExecutionContext } from "@agentmix/core";
import { AuditService } from "../audit/audit.service";
import { CapabilityExecutor } from "../capabilities/capability.executor";
import { DatabaseService } from "../database/database.service";
import {
  agents,
  agentDepartmentAccessGrants,
  agentRoleAccessGrants,
  agentRuntimes,
  agentToolBindings,
  agentUserAccessGrants,
  departments,
  mcpTools,
  modelProfiles,
  permissions,
  roles,
  subjectPermissions,
  subjectRoles,
  subjects,
  users,
} from "../database/schema";
import { AuthorizationService } from "../rbac/authorization.service";
import type { CreateAgentDto } from "./dto/create-agent.dto";
import type { ListAgentsDto } from "./dto/list-agents.dto";
import type { UpdateAgentDto } from "./dto/update-agent.dto";
import type { UpdateAgentAccessDto } from "./dto/update-agent-access.dto";
import type { UpdateAgentRuntimeDto } from "./dto/update-agent-runtime.dto";

interface ActorMetadata {
  actorSubjectId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

type DatabaseTransaction = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "23505") return true;
  return "cause" in error && isUniqueViolation(error.cause);
}

@Injectable()
export class AgentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly authorization: AuthorizationService,
    private readonly capabilities: CapabilityExecutor,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListAgentsDto) {
    const searchFilter = query.search
      ? or(ilike(agents.slug, `%${query.search}%`), ilike(agents.name, `%${query.search}%`))
      : undefined;
    const statusFilter = query.status ? eq(subjects.status, query.status) : undefined;
    const filter = and(searchFilter, statusFilter);
    const [items, totals] = await Promise.all([
      this.database.db
        .select({
          id: agents.subjectId,
          slug: agents.slug,
          name: agents.name,
          description: agents.description,
          isSystem: agents.isSystem,
          status: subjects.status,
          createdAt: agents.createdAt,
          updatedAt: agents.updatedAt,
        })
        .from(agents)
        .innerJoin(subjects, eq(agents.subjectId, subjects.id))
        .where(filter)
        .orderBy(desc(agents.createdAt))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.database.db
        .select({ value: count() })
        .from(agents)
        .innerJoin(subjects, eq(agents.subjectId, subjects.id))
        .where(filter),
    ]);

    return {
      items: items.map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
      total: totals[0]?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async getById(agentId: string) {
    const rows = await this.database.db
      .select({
        id: agents.subjectId,
        slug: agents.slug,
        name: agents.name,
        description: agents.description,
        isSystem: agents.isSystem,
        status: subjects.status,
        createdAt: agents.createdAt,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .innerJoin(subjects, eq(agents.subjectId, subjects.id))
      .where(eq(agents.subjectId, agentId))
      .limit(1);
    const agent = rows[0];
    if (!agent) throw new NotFoundException("Agent not found");

    const [assignedRoles, directPermissions, effectivePermissions] = await Promise.all([
      this.authorization.getRoles(agentId),
      this.database.db
        .select({
          id: permissions.id,
          resource: permissions.resource,
          action: permissions.action,
          description: permissions.description,
        })
        .from(subjectPermissions)
        .innerJoin(permissions, eq(subjectPermissions.permissionId, permissions.id))
        .where(eq(subjectPermissions.subjectId, agentId)),
      this.authorization.getEffectivePermissions(agentId),
    ]);

    return {
      ...agent,
      roles: assignedRoles,
      directPermissions: directPermissions.map((permission) => ({
        ...permission,
        key: `${permission.resource}:${permission.action}`,
      })),
      effectivePermissions,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  }

  async create(dto: CreateAgentDto, actor: ActorMetadata) {
    await this.assertCreateAssignmentPermissions(dto, actor);
    try {
      const agentId = await this.database.db.transaction(async (tx) => {
        await this.validateAssignments(tx, dto.roleIds, dto.permissionIds);
        const subject = await tx.insert(subjects).values({ type: "agent" }).returning({ id: subjects.id });
        const id = subject[0]!.id;
        await tx.insert(agents).values({
          subjectId: id,
          slug: dto.slug,
          name: dto.name,
          description: dto.description,
        });
        await this.replaceAssignments(tx, id, dto.roleIds, dto.permissionIds);
        await this.audit.record(
          {
            ...actor,
            action: "agent.created",
            resourceType: "agent",
            resourceId: id,
            outcome: "success",
            metadata: { slug: dto.slug, roleIds: dto.roleIds, permissionIds: dto.permissionIds },
          },
          tx,
        );
        return id;
      });
      return this.getById(agentId);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException("Agent slug already exists");
      throw error;
    }
  }

  private async assertCreateAssignmentPermissions(
    dto: CreateAgentDto,
    actor: ActorMetadata,
  ): Promise<void> {
    const requiredPermissions = [
      ...(dto.roleIds.length ? ["agents:assign-roles"] : []),
      ...(dto.permissionIds.length ? ["agents:assign-permissions"] : []),
    ];
    if (
      requiredPermissions.length === 0 ||
      (await this.authorization.hasPermissions(actor.actorSubjectId, requiredPermissions))
    ) {
      return;
    }

    await this.audit.record({
      ...actor,
      action: "authorization.denied",
      resourceType: "agent",
      resourceId: dto.slug,
      outcome: "failure",
      metadata: { requiredPermissions },
    });
    throw new ForbiddenException();
  }

  async update(agentId: string, dto: UpdateAgentDto, actor: ActorMetadata) {
    await this.database.db.transaction(async (tx) => {
      await this.ensureAgent(tx, agentId);
      const now = new Date();
      await Promise.all([
        tx.update(subjects).set({ status: dto.status, updatedAt: now }).where(eq(subjects.id, agentId)),
        tx
          .update(agents)
          .set({ name: dto.name, description: dto.description, updatedAt: now })
          .where(eq(agents.subjectId, agentId)),
      ]);
      await this.audit.record(
        {
          ...actor,
          action: "agent.updated",
          resourceType: "agent",
          resourceId: agentId,
          outcome: "success",
          metadata: {
            status: dto.status,
          },
        },
        tx,
      );
    });
    return this.getById(agentId);
  }

  async replaceRoles(agentId: string, roleIds: string[], actor: ActorMetadata): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await this.ensureAgent(tx, agentId);
      await this.validateRoles(tx, roleIds);
      await tx.delete(subjectRoles).where(eq(subjectRoles.subjectId, agentId));
      if (roleIds.length) {
        await tx.insert(subjectRoles).values(roleIds.map((roleId) => ({ subjectId: agentId, roleId })));
      }
      await this.audit.record(
        {
          ...actor,
          action: "agent.roles.updated",
          resourceType: "agent",
          resourceId: agentId,
          outcome: "success",
          metadata: { roleIds },
        },
        tx,
      );
    });
  }

  async replacePermissions(
    agentId: string,
    permissionIds: string[],
    actor: ActorMetadata,
  ): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await this.ensureAgent(tx, agentId);
      await this.validatePermissions(tx, permissionIds);
      await tx.delete(subjectPermissions).where(eq(subjectPermissions.subjectId, agentId));
      if (permissionIds.length) {
        await tx
          .insert(subjectPermissions)
          .values(permissionIds.map((permissionId) => ({ subjectId: agentId, permissionId })));
      }
      await this.audit.record(
        {
          ...actor,
          action: "agent.permissions.updated",
          resourceType: "agent",
          resourceId: agentId,
          outcome: "success",
          metadata: { permissionIds },
        },
        tx,
      );
    });
  }

  async getTools(agentId: string) {
    await this.getById(agentId);
    const rows = await this.database.db
      .select({ id: agentToolBindings.toolId })
      .from(agentToolBindings)
      .where(eq(agentToolBindings.agentSubjectId, agentId))
      .orderBy(agentToolBindings.toolId);
    return { agentId, toolIds: rows.map((row) => row.id) };
  }

  async replaceTools(agentId: string, toolIds: string[], actor: ActorMetadata): Promise<void> {
    if (new Set(toolIds).size !== toolIds.length) {
      throw new BadRequestException("Duplicate tool binding");
    }
    await this.database.db.transaction(async (tx) => {
      await this.ensureAgent(tx, agentId);
      if (toolIds.length) {
        const validTools = await tx
          .select({ id: mcpTools.id })
          .from(mcpTools)
          .where(and(inArray(mcpTools.id, toolIds), eq(mcpTools.enabled, true)));
        if (validTools.length !== toolIds.length) {
          throw new BadRequestException("Tool bindings may only reference enabled MCP tools");
        }
      }
      await tx.delete(agentToolBindings).where(eq(agentToolBindings.agentSubjectId, agentId));
      if (toolIds.length) {
        await tx.insert(agentToolBindings).values(
          toolIds.map((toolId) => ({
            agentSubjectId: agentId,
            toolId,
            createdBySubjectId: actor.actorSubjectId,
          })),
        );
      }
      await this.audit.record(
        {
          ...actor,
          action: "agent.tools.updated",
          resourceType: "agent",
          resourceId: agentId,
          outcome: "success",
          metadata: { toolIds },
        },
        tx,
      );
    });
  }

  async getRuntime(agentId: string) {
    await this.getById(agentId);
    const rows = await this.database.db
      .select({
        agentId: agentRuntimes.agentSubjectId,
        modelProfileId: agentRuntimes.modelProfileId,
        systemPrompt: agentRuntimes.systemPrompt,
        maxOutputTokens: agentRuntimes.maxOutputTokens,
        updatedAt: agentRuntimes.updatedAt,
        profileId: modelProfiles.id,
        profileKey: modelProfiles.key,
        profileName: modelProfiles.name,
        profileModelId: modelProfiles.modelId,
        profileStatus: modelProfiles.status,
      })
      .from(agentRuntimes)
      .innerJoin(modelProfiles, eq(agentRuntimes.modelProfileId, modelProfiles.id))
      .where(eq(agentRuntimes.agentSubjectId, agentId))
      .limit(1);
    const runtime = rows[0];
    if (!runtime) {
      return {
        agentId,
        configured: false,
        modelProfileId: null,
        systemPrompt: "",
        maxOutputTokens: 2_048,
        modelProfile: null,
        updatedAt: null,
      };
    }
    return {
      agentId,
      configured: true,
      modelProfileId: runtime.modelProfileId,
      systemPrompt: runtime.systemPrompt,
      maxOutputTokens: runtime.maxOutputTokens,
      modelProfile: {
        id: runtime.profileId,
        key: runtime.profileKey,
        name: runtime.profileName,
        modelId: runtime.profileModelId,
        status: runtime.profileStatus,
      },
      updatedAt: runtime.updatedAt.toISOString(),
    };
  }

  async updateRuntime(agentId: string, dto: UpdateAgentRuntimeDto, actor: ActorMetadata) {
    await this.database.db.transaction(async (tx) => {
      await this.ensureAgent(tx, agentId);
      const profile = await tx
        .select({ id: modelProfiles.id })
        .from(modelProfiles)
        .where(eq(modelProfiles.id, dto.modelProfileId))
        .limit(1);
      if (!profile[0]) throw new BadRequestException("Invalid model profile");
      const now = new Date();
      await tx
        .insert(agentRuntimes)
        .values({
          agentSubjectId: agentId,
          modelProfileId: dto.modelProfileId,
          systemPrompt: dto.systemPrompt,
          maxOutputTokens: dto.maxOutputTokens,
          maxSteps: 5,
        })
        .onConflictDoUpdate({
          target: agentRuntimes.agentSubjectId,
          set: {
            modelProfileId: dto.modelProfileId,
            systemPrompt: dto.systemPrompt,
            maxOutputTokens: dto.maxOutputTokens,
            maxSteps: 5,
            updatedAt: now,
          },
        });
      await this.audit.record(
        {
          ...actor,
          action: "agent.runtime.updated",
          resourceType: "agent",
          resourceId: agentId,
          outcome: "success",
          metadata: { modelProfileId: dto.modelProfileId, maxOutputTokens: dto.maxOutputTokens },
        },
        tx,
      );
    });
    return this.getRuntime(agentId);
  }

  async getAccess(agentId: string) {
    await this.getById(agentId);
    const [userRows, roleRows, departmentRows] = await Promise.all([
      this.database.db
        .select({ id: users.subjectId, username: users.username, displayName: users.displayName })
        .from(agentUserAccessGrants)
        .innerJoin(users, eq(agentUserAccessGrants.userSubjectId, users.subjectId))
        .where(eq(agentUserAccessGrants.agentSubjectId, agentId)),
      this.database.db
        .select({ id: roles.subjectId, key: roles.key, name: roles.name })
        .from(agentRoleAccessGrants)
        .innerJoin(roles, eq(agentRoleAccessGrants.roleSubjectId, roles.subjectId))
        .where(eq(agentRoleAccessGrants.agentSubjectId, agentId)),
      this.database.db
        .select({
          id: departments.id,
          code: departments.code,
          name: departments.name,
          includeDescendants: agentDepartmentAccessGrants.includeDescendants,
        })
        .from(agentDepartmentAccessGrants)
        .innerJoin(departments, eq(agentDepartmentAccessGrants.departmentId, departments.id))
        .where(eq(agentDepartmentAccessGrants.agentSubjectId, agentId)),
    ]);
    return { agentId, users: userRows, roles: roleRows, departments: departmentRows };
  }

  async updateAccess(agentId: string, dto: UpdateAgentAccessDto, actor: ActorMetadata) {
    const departmentIds = dto.departments.map((grant) => grant.departmentId);
    if (new Set(departmentIds).size !== departmentIds.length) {
      throw new BadRequestException("Duplicate department grant");
    }
    await this.database.db.transaction(async (tx) => {
      await this.ensureAgent(tx, agentId);
      const [validUsers, validRoles, validDepartments] = await Promise.all([
        dto.userIds.length
          ? tx
              .select({ id: users.subjectId })
              .from(users)
              .innerJoin(subjects, eq(users.subjectId, subjects.id))
              .where(and(inArray(users.subjectId, dto.userIds), eq(subjects.status, "active")))
          : Promise.resolve([]),
        dto.roleIds.length
          ? tx
              .select({ id: roles.subjectId })
              .from(roles)
              .innerJoin(subjects, eq(roles.subjectId, subjects.id))
              .where(and(inArray(roles.subjectId, dto.roleIds), eq(subjects.status, "active")))
          : Promise.resolve([]),
        departmentIds.length
          ? tx
              .select({ id: departments.id })
              .from(departments)
              .where(and(inArray(departments.id, departmentIds), eq(departments.status, "active")))
          : Promise.resolve([]),
      ]);
      if (
        validUsers.length !== dto.userIds.length ||
        validRoles.length !== dto.roleIds.length ||
        validDepartments.length !== departmentIds.length
      ) {
        throw new BadRequestException("One or more access grants are invalid");
      }
      await Promise.all([
        tx.delete(agentUserAccessGrants).where(eq(agentUserAccessGrants.agentSubjectId, agentId)),
        tx.delete(agentRoleAccessGrants).where(eq(agentRoleAccessGrants.agentSubjectId, agentId)),
        tx
          .delete(agentDepartmentAccessGrants)
          .where(eq(agentDepartmentAccessGrants.agentSubjectId, agentId)),
      ]);
      if (dto.userIds.length) {
        await tx.insert(agentUserAccessGrants).values(
          dto.userIds.map((userSubjectId) => ({
            agentSubjectId: agentId,
            userSubjectId,
            createdBySubjectId: actor.actorSubjectId,
          })),
        );
      }
      if (dto.roleIds.length) {
        await tx.insert(agentRoleAccessGrants).values(
          dto.roleIds.map((roleSubjectId) => ({
            agentSubjectId: agentId,
            roleSubjectId,
            createdBySubjectId: actor.actorSubjectId,
          })),
        );
      }
      if (dto.departments.length) {
        await tx.insert(agentDepartmentAccessGrants).values(
          dto.departments.map((grant) => ({
            agentSubjectId: agentId,
            departmentId: grant.departmentId,
            includeDescendants: grant.includeDescendants,
            createdBySubjectId: actor.actorSubjectId,
          })),
        );
      }
      await this.audit.record(
        {
          ...actor,
          action: "agent.access.updated",
          resourceType: "agent",
          resourceId: agentId,
          outcome: "success",
          metadata: {
            userIds: dto.userIds,
            roleIds: dto.roleIds,
            departments: dto.departments,
          },
        },
        tx,
      );
    });
    return this.getAccess(agentId);
  }

  async listCapabilities(agentId: string, context: CapabilityExecutionContext) {
    await this.getById(agentId);
    return this.capabilities.listAvailable(context);
  }

  private async ensureAgent(tx: DatabaseTransaction, agentId: string): Promise<void> {
    const rows = await tx
      .select({ id: agents.subjectId })
      .from(agents)
      .where(eq(agents.subjectId, agentId))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("Agent not found");
  }

  private async validateAssignments(
    tx: DatabaseTransaction,
    roleIds: string[],
    permissionIds: string[],
  ): Promise<void> {
    await Promise.all([this.validateRoles(tx, roleIds), this.validatePermissions(tx, permissionIds)]);
  }

  private async validateRoles(tx: DatabaseTransaction, roleIds: string[]): Promise<void> {
    if (roleIds.length === 0) return;
    const found = await tx
      .select({ id: roles.subjectId })
      .from(roles)
      .innerJoin(subjects, eq(roles.subjectId, subjects.id))
      .where(and(inArray(roles.subjectId, roleIds), eq(subjects.status, "active")));
    if (found.length !== roleIds.length) throw new BadRequestException("One or more roles are invalid");
  }

  private async validatePermissions(tx: DatabaseTransaction, permissionIds: string[]): Promise<void> {
    if (permissionIds.length === 0) return;
    const found = await tx
      .select({ id: permissions.id })
      .from(permissions)
      .where(inArray(permissions.id, permissionIds));
    if (found.length !== permissionIds.length) {
      throw new BadRequestException("One or more permissions are invalid");
    }
  }

  private async replaceAssignments(
    tx: DatabaseTransaction,
    agentId: string,
    roleIds: string[],
    permissionIds: string[],
  ): Promise<void> {
    await Promise.all([
      tx.delete(subjectRoles).where(eq(subjectRoles.subjectId, agentId)),
      tx.delete(subjectPermissions).where(eq(subjectPermissions.subjectId, agentId)),
    ]);
    if (roleIds.length) {
      await tx.insert(subjectRoles).values(roleIds.map((roleId) => ({ subjectId: agentId, roleId })));
    }
    if (permissionIds.length) {
      await tx
        .insert(subjectPermissions)
        .values(permissionIds.map((permissionId) => ({ subjectId: agentId, permissionId })));
    }
  }
}
