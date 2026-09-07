import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { RequirePermissions } from "../auth/auth.decorators";
import type { AuthenticatedRequest } from "../auth/auth.types";
import { getRequestMetadata } from "../auth/request-metadata";
import { CreateConversationDto } from "./dto/create-conversation.dto";
import { CreateMessageDto } from "./dto/create-message.dto";
import { ListConversationsDto } from "./dto/list-conversations.dto";
import { ConversationsService } from "./conversations.service";

@Controller("chat/agents")
export class ChatAgentsController {
  constructor(private readonly conversations: ConversationsService) {}

  @RequirePermissions("agents:invoke")
  @Get()
  list(@Req() request: AuthenticatedRequest) {
    return this.conversations.listInvokableAgents(request.auth.subjectId);
  }
}

@Controller("conversations")
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @RequirePermissions("agents:invoke")
  @HttpCode(202)
  @Post()
  create(
    @Body() dto: CreateConversationDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.conversations.create(dto.agentId, dto.content, idempotencyKey, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }

  @Get()
  list(@Query() query: ListConversationsDto, @Req() request: AuthenticatedRequest) {
    return this.conversations.list(request.auth.subjectId, query.page, query.pageSize);
  }

  @Get(":id")
  get(
    @Param("id", new ParseUUIDPipe()) conversationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.conversations.getDetail(conversationId, request.auth.subjectId);
  }

  @HttpCode(204)
  @Delete(":id")
  delete(
    @Param("id", new ParseUUIDPipe()) conversationId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.conversations.softDelete(conversationId, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }

  @RequirePermissions("agents:invoke")
  @HttpCode(202)
  @Post(":id/messages")
  addMessage(
    @Param("id", new ParseUUIDPipe()) conversationId: string,
    @Body() dto: CreateMessageDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.conversations.addMessage(conversationId, dto.content, idempotencyKey, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }
}

@Controller("runs")
export class RunsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get(":id")
  get(@Param("id", new ParseUUIDPipe()) runId: string, @Req() request: AuthenticatedRequest) {
    return this.conversations.getRun(runId, request.auth.subjectId);
  }

  @Header("Content-Type", "text/event-stream")
  @Get(":id/events")
  events(
    @Param("id", new ParseUUIDPipe()) runId: string,
    @Headers("last-event-id") lastEventId: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res() response: Response,
  ) {
    return this.conversations.streamEvents(runId, request.auth.subjectId, lastEventId, response);
  }

  @Post(":id/cancel")
  cancel(@Param("id", new ParseUUIDPipe()) runId: string, @Req() request: AuthenticatedRequest) {
    return this.conversations.cancel(runId, {
      actorSubjectId: request.auth.subjectId,
      ...getRequestMetadata(request),
    });
  }
}
