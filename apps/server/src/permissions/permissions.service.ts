import { Injectable } from "@nestjs/common";
import { asc } from "drizzle-orm";
import { DatabaseService } from "../database/database.service";
import { permissions } from "../database/schema";

@Injectable()
export class PermissionsService {
  constructor(private readonly database: DatabaseService) {}

  async list() {
    const rows = await this.database.db
      .select({
        id: permissions.id,
        resource: permissions.resource,
        action: permissions.action,
        description: permissions.description,
      })
      .from(permissions)
      .orderBy(asc(permissions.resource), asc(permissions.action));

    return rows.map((permission) => ({
      ...permission,
      key: `${permission.resource}:${permission.action}`,
    }));
  }
}
