import { Controller, Get } from "@nestjs/common";
import { RequirePermissions } from "../auth/auth.decorators";
import { DepartmentsService } from "./departments.service";

@Controller("departments")
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @RequirePermissions("departments:read")
  @Get()
  list() {
    return this.departments.list();
  }
}
