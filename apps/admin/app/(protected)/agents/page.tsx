import { redirect } from "next/navigation";
import { getAuthContext } from "../../_lib/auth";
import { serverApi } from "../../_lib/server-api";
import { AgentsManager } from "./agents-manager";
import type {
  AgentListResponse,
  DepartmentOption,
  ModelProfileOption,
  PermissionOption,
  RoleOption,
  UserListResponse,
} from "./types";

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
  const canReadUsers = auth.permissions.includes("users:read");
  const canReadDepartments = auth.permissions.includes("departments:read");
  const canReadModels = auth.permissions.includes("models:read");
  const [agents, roles, permissions, userResponse, departmentResponse, modelResponse] = await Promise.all([
    serverApi<AgentListResponse>(`/agents?${params}`),
    canReadRoles ? serverApi<RoleOption[]>("/roles") : Promise.resolve([]),
    canReadPermissions ? serverApi<PermissionOption[]>("/permissions") : Promise.resolve([]),
    canReadUsers
      ? serverApi<UserListResponse>("/users?page=1&pageSize=20")
      : Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 }),
    canReadDepartments
      ? serverApi<DepartmentOption[] | { items: DepartmentOption[] }>("/departments")
      : Promise.resolve([]),
    canReadModels
      ? serverApi<ModelProfileOption[] | { items: ModelProfileOption[] }>("/models")
      : Promise.resolve([]),
  ]);

  const canAssignRoles = auth.permissions.includes("agents:assign-roles") && canReadRoles;
  const canAssignPermissions =
    auth.permissions.includes("agents:assign-permissions") && canReadPermissions;
  const departments = Array.isArray(departmentResponse) ? departmentResponse : departmentResponse.items;
  const modelProfiles = Array.isArray(modelResponse) ? modelResponse : modelResponse.items;

  return (
    <AgentsManager
      key={`${page}:${search}:${status}`}
      initialData={agents}
      roles={roles}
      permissions={permissions}
      users={userResponse.items}
      userTotal={userResponse.total}
      departments={departments}
      modelProfiles={modelProfiles}
      query={{ search, status }}
      access={{
        canCreate: auth.permissions.includes("agents:create"),
        canUpdateProfile: auth.permissions.includes("agents:update"),
        canAssignRoles,
        canAssignPermissions,
        canConfigureRuntime: auth.permissions.includes("agents:configure-runtime") && canReadModels,
        canAssignAccess: auth.permissions.includes("agents:assign-access"),
        canReadUsers,
        canReadRoles,
        canReadDepartments,
      }}
    />
  );
}
