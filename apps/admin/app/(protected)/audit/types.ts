import type { AgentRunStatus, ConversationMessage, RunUsage } from "../chat/types";

export interface AuditActor {
  id: string;
  username?: string;
  displayName?: string;
}

export interface AuditEvent {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  outcome: "success" | "failure" | string;
  actorSubjectId?: string | null;
  actor?: AuditActor | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface ConversationAuditSummary {
  id: string;
  actor?: AuditActor | null;
  actorSubjectId?: string;
  agent?: { id: string; slug?: string; name: string } | null;
  agentId?: string;
  model?: { key?: string; modelId?: string; name?: string } | null;
  modelProfile?: { key?: string; modelId?: string; name?: string } | null;
  status: AgentRunStatus | "active" | "deleted";
  usage?: RunUsage | null;
  errorCode?: string | null;
  runCompletedAt?: string | null;
  messageCount?: number;
  runCount?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
}

export interface ConversationAuditDetail extends ConversationAuditSummary {
  runs?: Array<{
    id: string;
    status: AgentRunStatus;
    attempt: number;
    usage: RunUsage | null;
    errorCode: string | null;
    createdAt?: string;
    completedAt?: string | null;
  }>;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ConversationAuditMessagesResponse {
  items: ConversationMessage[];
}
