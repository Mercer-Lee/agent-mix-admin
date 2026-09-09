import type { AgentRunStatus, RunUsage } from "../chat/types";
import type { ConversationAuditDetail, ConversationAuditSummary } from "./types";

export interface ConversationAuditApiItem {
  id: string;
  userSubjectId?: string;
  username?: string;
  displayName?: string;
  agentSubjectId?: string;
  agentSlug?: string;
  agentName?: string;
  latestStatus?: string | null;
  modelProfileId?: string | null;
  modelKey?: string | null;
  modelId?: string | null;
  usage?: RunUsage | Record<string, unknown> | null;
  errorCode?: string | null;
  runCompletedAt?: string | null;
  lastMessageAt?: string;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ConversationAuditApiRun {
  id: string;
  status: string;
  attempt: number;
  modelProfileId?: string;
  modelKey?: string;
  modelId?: string;
  usage?: RunUsage | null;
  errorCode?: string | null;
  queuedAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface ConversationAuditApiDetail {
  conversation: ConversationAuditApiItem;
  runs: ConversationAuditApiRun[];
}

function auditStatus(item: ConversationAuditApiItem): ConversationAuditSummary["status"] {
  if (item.deletedAt) return "deleted";
  return (item.latestStatus as AgentRunStatus | null) ?? "active";
}

export function normalizeConversationAudit(
  item: ConversationAuditApiItem | ConversationAuditSummary,
): ConversationAuditSummary {
  if ("status" in item) return item;
  return {
    id: item.id,
    actor: item.userSubjectId ? {
      id: item.userSubjectId,
      username: item.username,
      displayName: item.displayName,
    } : null,
    actorSubjectId: item.userSubjectId,
    agent: item.agentSubjectId ? {
      id: item.agentSubjectId,
      slug: item.agentSlug,
      name: item.agentName ?? item.agentSlug ?? item.agentSubjectId,
    } : null,
    agentId: item.agentSubjectId,
    model: item.modelProfileId || item.modelKey || item.modelId ? {
      key: item.modelKey ?? undefined,
      modelId: item.modelId ?? undefined,
    } : null,
    status: auditStatus(item),
    usage: (item.usage as RunUsage | null | undefined) ?? null,
    errorCode: item.errorCode,
    runCompletedAt: item.runCompletedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt,
  };
}

export function normalizeConversationAuditDetail(
  value: ConversationAuditDetail | ConversationAuditApiDetail,
): ConversationAuditDetail {
  if (!("conversation" in value)) return value;
  const latestRun = value.runs.at(-1);
  const conversation = normalizeConversationAudit({
    ...value.conversation,
    latestStatus: latestRun?.status ?? null,
  });
  return {
    ...conversation,
    model: latestRun ? {
      key: latestRun.modelKey,
      modelId: latestRun.modelId,
    } : null,
    usage: latestRun?.usage ?? null,
    runs: value.runs.map((run) => ({
      id: run.id,
      status: run.status as AgentRunStatus,
      attempt: run.attempt,
      usage: run.usage ?? null,
      errorCode: run.errorCode ?? null,
      createdAt: run.queuedAt,
      completedAt: run.completedAt,
    })),
  };
}
