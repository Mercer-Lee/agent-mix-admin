export interface ChatAgent {
  id: string;
  slug: string;
  name: string;
  description: string;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  agentId?: string;
  agent?: ChatAgent;
  status?: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  conversationId?: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: string;
  runId?: string | null;
}

export interface RunUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
}

export type AgentRunStatus = "queued" | "running" | "completed" | "failed" | "canceled" | "cancelled";

export interface AgentRun {
  id: string;
  conversationId: string;
  status: AgentRunStatus;
  attempt: number;
  usage: RunUsage | null;
  errorCode: string | null;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  assistantMessage?: ConversationMessage | null;
}

export interface ChatAgentListResponse {
  items: ChatAgent[];
}

export interface ConversationListResponse {
  items: ConversationSummary[];
}

export interface ConversationDetailResponse {
  conversation: ConversationSummary;
  messages: ConversationMessage[];
  activeRun: AgentRun | null;
}

export interface CreateConversationResponse {
  conversation: ConversationSummary;
  run: AgentRun;
}

export interface CreateRunResponse {
  run: AgentRun;
}
