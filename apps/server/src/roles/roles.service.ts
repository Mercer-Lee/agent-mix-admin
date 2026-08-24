import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DatabaseService } from "../database/database.service";
import { roles, subjects } from "../database/schema";

@Injectable()
export class RolesService {
  constructor(private readonly database: DatabaseService) {}

  list() {
    return this.database.db
      .select({
        id: roles.subjectId,
        key: roles.key,
        name: roles.name,
        description: roles.description,
        isSystem: roles.isSystem,
      })
      .from(roles)
      .innerJoin(subjects, eq(roles.subjectId, subjects.id))
      .where(eq(subjects.status, "active"))
      .orderBy(roles.name);
  }
}
