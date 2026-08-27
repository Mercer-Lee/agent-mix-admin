import { randomUUID } from "node:crypto";
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req } from "@nestjs/common";
import { RequirePermissions } from "../auth/auth.decorators";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { getRequestMetadata } from "../auth/request-metadata";
import { AgentsService } from "./agents.service";
import { CreateAgentDto } from "./dto/create-agent.dto";
import { ListAgentsDto } from "./dto/list-agents.dto";
import { ReplaceAgentPermissionsDto } from "./dto/replace-agent-permissions.dto";
import { ReplaceAgentRolesDto } from "./dto/replace-agent-roles.dto";
import { UpdateAgentDto } from "./dto/update-agent.dto";

@Controller("agents")
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @RequirePermissions("agents:read")
  @Get()
  list(@Query() query: ListAgentsDto) {
    return this.agents.list(query);
  }

  @RequirePermissions("agents:read")
  @Get(":id/capabilities")
  listCapabilities(
    @Param("id", new ParseUUIDPipe()) agentId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.agents.listCapabilities(agentId, {
      actorSubjectId: request.auth.subjectId,
      agentSubjectId: agentId,
      traceId: randomUUID(),
    });
  }

  @RequirePermissions("agents:read")
  @Get(":id")
  getById(@Param("id", new ParseUUIDPipe()) agentId: string) {
    return this.agents.getById(agentId);
  }

  @RequirePermissions("agents:create")
  @Post()
  create(@Body() dto: CreateAgentDto, @Req() request: AuthenticatedRequest) {
    return this.agents.create(dto, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }

  @RequirePermissions("agents:update", "agents:assign-roles", "agents:assign-permissions")
  @Put(":id")
  update(
    @Param("id", new ParseUUIDPipe()) agentId: string,
    @Body() dto: UpdateAgentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.agents.update(agentId, dto, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }

  @RequirePermissions("agents:assign-roles")
  @HttpCode(204)
  @Put(":id/roles")
  replaceRoles(
    @Param("id", new ParseUUIDPipe()) agentId: string,
    @Body() dto: ReplaceAgentRolesDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.agents.replaceRoles(agentId, dto.roleIds, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }

  @RequirePermissions("agents:assign-permissions")
  @HttpCode(204)
  @Put(":id/permissions")
  replacePermissions(
    @Param("id", new ParseUUIDPipe()) agentId: string,
    @Body() dto: ReplaceAgentPermissionsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.agents.replacePermissions(agentId, dto.permissionIds, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }
}
