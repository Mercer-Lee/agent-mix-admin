import { redirect } from "next/navigation";
import { getAuthContext } from "../../_lib/auth";
import { ChatWorkspace } from "./chat-workspace";
import { getChatShellData } from "./data";

export default async function ChatPage() {
  const auth = await getAuthContext();
  if (!auth?.permissions.includes("agents:invoke")) redirect("/");
  const data = await getChatShellData();
  return <ChatWorkspace initialAgents={data.agents} initialConversations={data.conversations} />;
}
