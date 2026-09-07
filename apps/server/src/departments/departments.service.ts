import { Injectable } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { DatabaseService } from "../database/database.service";
import { departments } from "../database/schema";

@Injectable()
export class DepartmentsService {
  constructor(private readonly database: DatabaseService) {}

  list() {
    return this.database.db
      .select({
        id: departments.id,
        parentId: departments.parentId,
        code: departments.code,
        name: departments.name,
        sortOrder: departments.sortOrder,
      })
      .from(departments)
      .where(eq(departments.status, "active"))
      .orderBy(asc(departments.sortOrder), asc(departments.name));
  }
}
