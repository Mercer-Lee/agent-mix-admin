import { Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DatabaseService } from "../database/database.service";
import { permissions, roles, subjectPermissions, subjectRoles, subjects } from "../database/schema";

type SubjectType = "user" | "role" | "agent";

@Injectable()
export class AuthorizationService {
  constructor(private readonly database: DatabaseService) {}

  async getRoles(subjectId: string): Promise<Array<{ id: string; key: string; name: string }>> {
    return this.database.db
      .select({ id: roles.subjectId, key: roles.key, name: roles.name })
      .from(subjectRoles)
      .innerJoin(roles, eq(subjectRoles.roleId, roles.subjectId))
      .innerJoin(subjects, eq(roles.subjectId, subjects.id))
      .where(and(eq(subjectRoles.subjectId, subjectId), eq(subjects.status, "active")));
  }

  async getEffectivePermissions(subjectId: string): Promise<string[]> {
    const subject = await this.database.db
      .select({ status: subjects.status })
      .from(subjects)
      .where(eq(subjects.id, subjectId))
      .limit(1);

    if (subject[0]?.status !== "active") {
      return [];
    }

    return this.getGrantedPermissions(subjectId);
  }

  async getEffectivePermissionsForSubject(
    subjectId: string,
    expectedType: SubjectType,
  ): Promise<string[] | null> {
    const subject = await this.database.db
      .select({ type: subjects.type, status: subjects.status })
      .from(subjects)
      .where(eq(subjects.id, subjectId))
      .limit(1);

    if (subject[0]?.status !== "active" || subject[0].type !== expectedType) {
      return null;
    }

    return this.getGrantedPermissions(subjectId);
  }

  private async getGrantedPermissions(subjectId: string): Promise<string[]> {
    const assignedRoles = await this.getRoles(subjectId);
    const permissionSubjectIds = [subjectId, ...assignedRoles.map((role) => role.id)];
    const rows = await this.database.db
      .select({ resource: permissions.resource, action: permissions.action })
      .from(subjectPermissions)
      .innerJoin(permissions, eq(subjectPermissions.permissionId, permissions.id))
      .where(inArray(subjectPermissions.subjectId, permissionSubjectIds));

    return [...new Set(rows.map((permission) => `${permission.resource}:${permission.action}`))].sort();
  }

  async hasPermissions(subjectId: string, required: string[]): Promise<boolean> {
    if (required.length === 0) return true;
    const available = new Set(await this.getEffectivePermissions(subjectId));
    return required.every((permission) => available.has(permission));
  }
}
