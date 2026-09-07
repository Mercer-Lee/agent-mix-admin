import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from "@nestjs/common";
import { RequirePermissions } from "../auth/auth.decorators";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { getRequestMetadata } from "../auth/request-metadata";
import { CreateModelDto } from "./dto/create-model.dto";
import { UpdateModelDto } from "./dto/update-model.dto";
import { ModelsService } from "./models.service";

@Controller("models")
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @RequirePermissions("models:read")
  @Get()
  list() {
    return this.models.list();
  }

  @RequirePermissions("models:create")
  @Post()
  create(@Body() dto: CreateModelDto, @Req() request: AuthenticatedRequest) {
    return this.models.create(dto, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }

  @RequirePermissions("models:update")
  @Put(":id")
  update(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateModelDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.models.update(id, dto, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }

  @RequirePermissions("models:test")
  @HttpCode(202)
  @Post(":id/check")
  check(@Param("id", new ParseUUIDPipe()) id: string, @Req() request: AuthenticatedRequest) {
    return this.models.check(id, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }
}

@Controller("model-checks")
export class ModelChecksController {
  constructor(private readonly models: ModelsService) {}

  @RequirePermissions("models:read")
  @Get(":id")
  get(@Param("id", new ParseUUIDPipe()) id: string) {
    return this.models.getCheck(id);
  }
}
