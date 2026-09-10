import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { RequirePermissions } from "../auth/auth.decorators";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { getRequestMetadata } from "../auth/request-metadata";
import { CreateMcpServerDto } from "./dto/create-mcp-server.dto";
import { UpdateMcpServerDto } from "./dto/update-mcp-server.dto";
import { UpdateMcpToolDto } from "./dto/update-mcp-tool.dto";
import { McpService } from "./mcp.service";

@Controller("mcp/servers")
export class McpServersController {
  constructor(private readonly mcp: McpService) {}

  @RequirePermissions("mcp-servers:read")
  @Get()
  list() {
    return this.mcp.list();
  }

  @RequirePermissions("mcp-servers:manage")
  @Post()
  create(@Body() dto: CreateMcpServerDto, @Req() request: AuthenticatedRequest) {
    return this.mcp.create(dto, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }

  @RequirePermissions("mcp-servers:manage")
  @Put(":id")
  update(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateMcpServerDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.mcp.update(id, dto, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }

  @RequirePermissions("mcp-servers:manage")
  @Delete(":id")
  remove(@Param("id", new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest) {
    return this.mcp.remove(id, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }

  @RequirePermissions("mcp-servers:manage")
  @HttpCode(200)
  @Post(":id/sync")
  sync(@Param("id", new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest) {
    return this.mcp.sync(id, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }

  @RequirePermissions("mcp-servers:read")
  @Get(":id/tools")
  listTools(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.mcp.listTools(id);
  }
}

@Controller("mcp/tools")
export class McpToolsController {
  constructor(private readonly mcp: McpService) {}

  @RequirePermissions("mcp-servers:manage")
  @Put(":id")
  updateTool(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateMcpToolDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.mcp.updateTool(id, dto, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }
}
