import { redirect } from "next/navigation";
import { getAuthContext } from "../../_lib/auth";
import { serverApi } from "../../_lib/server-api";
import { AgentsManager } from "./agents-manager";
import type { AgentListResponse, PermissionOption, RoleOption } from "./types";

interface AgentsPageProps {
  searchParams: Promise<{ page?: string; search?: string; status?: string }>;
}

export default async function AgentsPage({ searchParams }: AgentsPageProps) {
  const [auth, query] = await Promise.all([getAuthContext(), searchParams]);
  if (!auth?.permissions.includes("agents:read")) redirect("/");

  const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
  const search = query.search?.trim().slice(0, 100) ?? "";
  const status = query.status === "active" || query.status === "disabled" ? query.status : "";
  const params = new URLSearchParams({ page: String(page), pageSize: "20" });
  if (search) params.set("search", search);
  if (status) params.set("status", status);

  const canReadRoles = auth.permissions.includes("roles:read");
  const canReadPermissions = auth.permissions.includes("permissions:read");
  const [agents, roles, permissions] = await Promise.all([
    serverApi<AgentListResponse>(`/agents?${params}`),
    canReadRoles ? serverApi<RoleOption[]>("/roles") : Promise.resolve([]),
    canReadPermissions ? serverApi<PermissionOption[]>("/permissions") : Promise.resolve([]),
  ]);

  const canAssignRoles = auth.permissions.includes("agents:assign-roles") && canReadRoles;
  const canAssignPermissions =
    auth.permissions.includes("agents:assign-permissions") && canReadPermissions;

  return (
    <AgentsManager
      key={`${page}:${search}:${status}`}
      initialData={agents}
      roles={roles}
      permissions={permissions}
      query={{ search, status }}
      access={{
        canCreate: auth.permissions.includes("agents:create"),
        canAssignRoles,
        canAssignPermissions,
        canUpdateAll:
          auth.permissions.includes("agents:update") && canAssignRoles && canAssignPermissions,
      }}
    />
  );
}
