import "server-only";

import { serverApi } from "../../_lib/server-api";
import type {
  ChatAgent,
  ChatAgentListResponse,
  ConversationDetailResponse,
  ConversationListResponse,
  ConversationSummary,
} from "./types";

export async function getChatShellData() {
  const [agentResponse, conversationResponse] = await Promise.all([
    serverApi<ChatAgentListResponse | ChatAgent[]>("/chat/agents"),
    serverApi<ConversationListResponse | ConversationSummary[]>("/conversations?page=1&pageSize=100"),
  ]);
  return {
    agents: Array.isArray(agentResponse) ? agentResponse : agentResponse.items,
    conversations: Array.isArray(conversationResponse) ? conversationResponse : conversationResponse.items,
  };
}

export function getConversationDetail(conversationId: string) {
  return serverApi<ConversationDetailResponse>(`/conversations/${conversationId}`);
}
