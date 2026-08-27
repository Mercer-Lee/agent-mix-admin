export interface AgentSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface AgentListResponse {
  items: AgentSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RoleOption {
  id: string;
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
}

export interface PermissionOption {
  id: string;
  key: string;
  resource: string;
  action: string;
  description: string;
}

export interface AgentDetail extends AgentSummary {
  roles: Array<Pick<RoleOption, "id" | "key" | "name">>;
  directPermissions: PermissionOption[];
  effectivePermissions: string[];
}

export interface CapabilityDescriptor {
  id: string;
  version: string;
  module: string;
  description: string;
  risk: string;
  requiredPermissions: string[];
}

export interface AgentMutationInput {
  slug?: string;
  name: string;
  description: string;
  status?: "active" | "disabled";
  roleIds: string[];
  permissionIds: string[];
}

export interface AgentAccess {
  canCreate: boolean;
  canAssignRoles: boolean;
  canAssignPermissions: boolean;
  canUpdateAll: boolean;
}
