export interface AgentSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  status: "active" | "disabled";
  isSystem?: boolean;
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

export interface UserOption {
  id: string;
  username: string;
  displayName: string;
  status?: "active" | "disabled";
}

export interface UserListResponse {
  items: UserOption[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DepartmentOption {
  id: string;
  code: string;
  name: string;
  parentId?: string | null;
  status?: "active" | "disabled";
}

export interface ModelProfileOption {
  id: string;
  key: string;
  name: string;
  modelId: string;
  status: "active" | "disabled";
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

export interface AgentProfileMutationInput {
  slug?: string;
  name: string;
  description: string;
  status?: "active" | "disabled";
}

export interface AgentRuntime {
  agentId: string;
  configured: boolean;
  modelProfileId: string | null;
  systemPrompt: string;
  maxOutputTokens: number;
  modelProfile: ModelProfileOption | null;
  updatedAt: string | null;
}

export interface AgentRuntimeMutationInput {
  modelProfileId: string;
  systemPrompt: string;
  maxOutputTokens: number;
}

export interface AgentInvocationAccess {
  agentId: string;
  users: UserOption[];
  roles: Array<Pick<RoleOption, "id" | "key" | "name">>;
  departments: Array<Pick<DepartmentOption, "id" | "code" | "name"> & { includeDescendants: boolean }>;
}

export interface AgentInvocationAccessInput {
  userIds: string[];
  roleIds: string[];
  departments: Array<{ departmentId: string; includeDescendants: boolean }>;
}

export interface AgentToolsState {
  agentId: string;
  toolIds: string[];
}

export interface McpToolOption {
  id: string;
  serverSlug: string;
  serverName: string;
  name: string;
  description: string;
  risk: "read" | "sensitive_read" | "write" | "critical";
  requiredPermissions: string[];
  enabled: boolean;
}

export interface AgentManagerAccess {
  canCreate: boolean;
  canUpdateProfile: boolean;
  canAssignRoles: boolean;
  canAssignPermissions: boolean;
  canConfigureRuntime: boolean;
  canAssignAccess: boolean;
  canAssignTools: boolean;
  canReadMcpServers: boolean;
  canReadUsers: boolean;
  canReadRoles: boolean;
  canReadDepartments: boolean;
}
