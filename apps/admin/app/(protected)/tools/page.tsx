import { redirect } from "next/navigation";
import { getAuthContext } from "../../_lib/auth";
import { serverApi } from "../../_lib/server-api";
import { ToolsManager } from "./tools-manager";
import type { McpServerListResponse } from "./types";

export default async function ToolsPage() {
  const auth = await getAuthContext();
  if (!auth?.permissions.includes("mcp-servers:read")) redirect("/");

  const servers = await serverApi<McpServerListResponse>("/mcp/servers");

  return (
    <ToolsManager
      initialData={servers}
      access={{ canManage: auth.permissions.includes("mcp-servers:manage") }}
    />
  );
}
