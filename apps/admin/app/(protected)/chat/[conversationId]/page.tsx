import { redirect } from "next/navigation";
import { getAuthContext } from "../../../_lib/auth";
import { ServerApiError } from "../../../_lib/server-api";
import { ChatWorkspace } from "../chat-workspace";
import { getChatShellData, getConversationDetail } from "../data";

interface ConversationPageProps {
  params: Promise<{ conversationId: string }>;
}

export default async function ConversationPage({ params }: ConversationPageProps) {
  const [auth, { conversationId }] = await Promise.all([getAuthContext(), params]);
  if (!auth?.permissions.includes("agents:invoke")) redirect("/");

  try {
    const [shell, detail] = await Promise.all([getChatShellData(), getConversationDetail(conversationId)]);
    return (
      <ChatWorkspace
        initialAgents={shell.agents}
        initialConversations={shell.conversations}
        initialDetail={detail}
      />
    );
  } catch (error) {
    if (error instanceof ServerApiError && (error.status === 403 || error.status === 404)) {
      redirect("/chat");
    }
    throw error;
  }
}
