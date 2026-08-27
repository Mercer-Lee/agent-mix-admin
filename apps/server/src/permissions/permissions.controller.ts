import { Controller, Get } from "@nestjs/common";
import { RequirePermissions } from "../auth/auth.decorators";
import { PermissionsService } from "./permissions.service";

@Controller("permissions")
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @RequirePermissions("permissions:read")
  @Get()
  list() {
    return this.permissions.list();
  }
}
