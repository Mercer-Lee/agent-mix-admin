import { redirect } from "next/navigation";
import { getAuthContext } from "../../_lib/auth";
import { serverApi } from "../../_lib/server-api";
import { AuditConsole } from "./audit-console";
import { normalizeConversationAudit, type ConversationAuditApiItem } from "./normalize";
import type { AuditEvent, ConversationAuditSummary, PaginatedResponse } from "./types";

interface AuditPageProps {
  searchParams: Promise<{ eventsPage?: string; conversationsPage?: string }>;
}

export default async function AuditPage({ searchParams }: AuditPageProps) {
  const [auth, query] = await Promise.all([getAuthContext(), searchParams]);
  const canReadEvents = auth?.permissions.includes("audit-logs:read") ?? false;
  const canAuditConversations = auth?.permissions.includes("conversations:audit") ?? false;
  if (!auth || (!canReadEvents && !canAuditConversations)) redirect("/");

  const eventsPage = Math.max(1, Number.parseInt(query.eventsPage ?? "1", 10) || 1);
  const conversationsPage = Math.max(1, Number.parseInt(query.conversationsPage ?? "1", 10) || 1);
  const [events, conversationResponse] = await Promise.all([
    canReadEvents
      ? serverApi<PaginatedResponse<AuditEvent>>(`/audit/events?page=${eventsPage}&pageSize=50`)
      : Promise.resolve(null),
    canAuditConversations
      ? serverApi<PaginatedResponse<ConversationAuditApiItem | ConversationAuditSummary>>(`/audit/conversations?page=${conversationsPage}&pageSize=50`)
      : Promise.resolve(null),
  ]);
  const conversations: PaginatedResponse<ConversationAuditSummary> | null = conversationResponse
    ? { ...conversationResponse, items: conversationResponse.items.map(normalizeConversationAudit) }
    : null;

  return (
    <AuditConsole
      events={events}
      conversations={conversations}
      canReadContent={auth.permissions.includes("conversations:read-content")}
    />
  );
}
