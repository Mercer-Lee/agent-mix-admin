import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from "@nestjs/common";
import { RequirePermissions } from "../auth/auth.decorators";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { getRequestMetadata } from "../auth/request-metadata";
import { CreateUserDto } from "./dto/create-user.dto";
import { ListUsersDto } from "./dto/list-users.dto";
import { ReplaceUserRolesDto } from "./dto/replace-user-roles.dto";
import { UsersService } from "./users.service";

@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermissions("users:read")
  @Get()
  list(@Query() query: ListUsersDto) {
    return this.users.list(query);
  }

  @RequirePermissions("users:create")
  @Post()
  create(@Body() dto: CreateUserDto, @Req() request: AuthenticatedRequest) {
    return this.users.create(dto, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }

  @RequirePermissions("users:assign-roles")
  @HttpCode(204)
  @Put(":id/roles")
  replaceRoles(
    @Param("id", new ParseUUIDPipe()) userId: string,
    @Body() dto: ReplaceUserRolesDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.users.replaceRoles(userId, dto.roleIds, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }
}
