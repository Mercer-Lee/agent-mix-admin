import { Controller, Get } from "@nestjs/common";
import { RequirePermissions } from "../auth/auth.decorators";
import { RolesService } from "./roles.service";

@Controller("roles")
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @RequirePermissions("roles:read")
  @Get()
  list() {
    return this.roles.list();
  }
}
