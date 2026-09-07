import { Controller, Get, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { RequirePermissions } from "../auth/auth.decorators";
import { AuditService } from "./audit.service";
import { ListAuditDto, ListConversationAuditDto } from "./dto/list-audit.dto";

@Controller("audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @RequirePermissions("audit-logs:read")
  @Get("events")
  events(@Query() query: ListAuditDto) {
    return this.audit.listEvents(query);
  }

  @RequirePermissions("conversations:audit")
  @Get("conversations")
  conversations(@Query() query: ListConversationAuditDto) {
    return this.audit.listConversations(query);
  }

  @RequirePermissions("conversations:audit")
  @Get("conversations/:id")
  conversation(@Param("id", new ParseUUIDPipe()) conversationId: string) {
    return this.audit.getConversation(conversationId);
  }

  @RequirePermissions("conversations:audit", "conversations:read-content")
  @Get("conversations/:id/messages")
  messages(@Param("id", new ParseUUIDPipe()) conversationId: string) {
    return this.audit.getConversationMessages(conversationId);
  }
}
