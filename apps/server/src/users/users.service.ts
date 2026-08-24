import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, eq, ilike, inArray, or } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import { departments, roles, subjectRoles, subjects, users } from "../database/schema";
import { PasswordService } from "../auth/password.service";
import type { CreateUserDto } from "./dto/create-user.dto";
import type { ListUsersDto } from "./dto/list-users.dto";

interface ActorMetadata {
  actorSubjectId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "23505") return true;
  return "cause" in error && isUniqueViolation(error.cause);
}

@Injectable()
export class UsersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ListUsersDto) {
    const filter = query.search
      ? or(ilike(users.username, `%${query.search}%`), ilike(users.displayName, `%${query.search}%`))
      : undefined;
    const [items, totals] = await Promise.all([
      this.database.db
        .select({
          id: users.subjectId,
          username: users.username,
          displayName: users.displayName,
          email: users.email,
          status: subjects.status,
          departmentId: departments.id,
          departmentCode: departments.code,
          departmentName: departments.name,
          createdAt: users.createdAt,
        })
        .from(users)
        .innerJoin(subjects, eq(users.subjectId, subjects.id))
        .leftJoin(departments, eq(users.departmentId, departments.id))
        .where(filter)
        .orderBy(users.createdAt)
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      this.database.db.select({ value: count() }).from(users).where(filter),
    ]);
    return {
      items: items.map((item) => ({
        id: item.id,
        username: item.username,
        displayName: item.displayName,
        email: item.email,
        status: item.status,
        department: item.departmentId
          ? { id: item.departmentId, code: item.departmentCode!, name: item.departmentName! }
          : null,
        createdAt: item.createdAt.toISOString(),
      })),
      total: totals[0]?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async create(dto: CreateUserDto, actor: ActorMetadata) {
    const passwordHash = await this.passwords.hash(dto.password);
    try {
      const created = await this.database.db.transaction(async (tx) => {
        if (dto.departmentId) {
          const department = await tx
            .select({ id: departments.id })
            .from(departments)
            .where(and(eq(departments.id, dto.departmentId), eq(departments.status, "active")))
            .limit(1);
          if (!department[0]) throw new BadRequestException("Invalid department");
        }
        await this.validateRoles(tx, dto.roleIds ?? []);
        const subject = await tx.insert(subjects).values({ type: "user" }).returning({ id: subjects.id });
        const subjectId = subject[0]!.id;
        await tx.insert(users).values({
          subjectId,
          username: dto.username,
          passwordHash,
          displayName: dto.displayName,
          email: dto.email ?? null,
          departmentId: dto.departmentId ?? null,
        });
        if (dto.roleIds?.length) {
          await tx.insert(subjectRoles).values(dto.roleIds.map((roleId) => ({ subjectId, roleId })));
        }
        return subjectId;
      });
      await this.audit.record({
        ...actor,
        action: "user.created",
        resourceType: "user",
        resourceId: created,
        outcome: "success",
        metadata: { username: dto.username, roleIds: dto.roleIds ?? [] },
      });
      return { id: created, username: dto.username, displayName: dto.displayName, email: dto.email ?? null };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException("Username or email already exists");
      throw error;
    }
  }

  async replaceRoles(userId: string, roleIds: string[], actor: ActorMetadata): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const user = await tx.select({ id: users.subjectId }).from(users).where(eq(users.subjectId, userId)).limit(1);
      if (!user[0]) throw new NotFoundException("User not found");
      await this.validateRoles(tx, roleIds);
      await tx.delete(subjectRoles).where(eq(subjectRoles.subjectId, userId));
      if (roleIds.length) {
        await tx.insert(subjectRoles).values(roleIds.map((roleId) => ({ subjectId: userId, roleId })));
      }
    });
    await this.audit.record({
      ...actor,
      action: "user.roles.updated",
      resourceType: "user",
      resourceId: userId,
      outcome: "success",
      metadata: { roleIds },
    });
  }

  private async validateRoles(
    tx: Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0],
    roleIds: string[],
  ): Promise<void> {
    if (roleIds.length === 0) return;
    const found = await tx
      .select({ id: roles.subjectId })
      .from(roles)
      .innerJoin(subjects, eq(roles.subjectId, subjects.id))
      .where(and(inArray(roles.subjectId, roleIds), eq(subjects.status, "active")));
    if (found.length !== roleIds.length) throw new BadRequestException("One or more roles are invalid");
  }
}
