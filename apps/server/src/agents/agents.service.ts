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
  permissions,
  roles,
  subjectPermissions,
  subjectRoles,
  subjects,
} from "../database/schema";
import { AuthorizationService } from "../rbac/authorization.service";
import type { CreateAgentDto } from "./dto/create-agent.dto";
import type { ListAgentsDto } from "./dto/list-agents.dto";
import type { UpdateAgentDto } from "./dto/update-agent.dto";

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
        return id;
      });
      await this.audit.record({
        ...actor,
        action: "agent.created",
        resourceType: "agent",
        resourceId: agentId,
        outcome: "success",
        metadata: { slug: dto.slug, roleIds: dto.roleIds, permissionIds: dto.permissionIds },
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
      await this.validateAssignments(tx, dto.roleIds, dto.permissionIds);
      const now = new Date();
      await Promise.all([
        tx.update(subjects).set({ status: dto.status, updatedAt: now }).where(eq(subjects.id, agentId)),
        tx
          .update(agents)
          .set({ name: dto.name, description: dto.description, updatedAt: now })
          .where(eq(agents.subjectId, agentId)),
      ]);
      await this.replaceAssignments(tx, agentId, dto.roleIds, dto.permissionIds);
    });
    await this.audit.record({
      ...actor,
      action: "agent.updated",
      resourceType: "agent",
      resourceId: agentId,
      outcome: "success",
      metadata: {
        status: dto.status,
        roleIds: dto.roleIds,
        permissionIds: dto.permissionIds,
      },
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
    });
    await this.audit.record({
      ...actor,
      action: "agent.roles.updated",
      resourceType: "agent",
      resourceId: agentId,
      outcome: "success",
      metadata: { roleIds },
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
    });
    await this.audit.record({
      ...actor,
      action: "agent.permissions.updated",
      resourceType: "agent",
      resourceId: agentId,
      outcome: "success",
      metadata: { permissionIds },
    });
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
