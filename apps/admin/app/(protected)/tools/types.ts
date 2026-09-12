export type McpServerStatus = "active" | "disabled";
export type McpToolRisk = "read" | "sensitive_read" | "write" | "critical";

export interface McpServer {
  id: string;
  slug: string;
  name: string;
  description: string;
  endpointUrl: string;
  hasAuth: boolean;
  /** Name of the environment variable holding the secret — never the secret. */
  authEnvVar: string | null;
  status: McpServerStatus;
  toolCount: number;
  lastSyncedAt: string | null;
  lastSyncErrorCode: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface McpServerListResponse {
  items: McpServer[];
}

export interface McpServerCreateInput {
  slug: string;
  name: string;
  description: string;
  endpointUrl: string;
  /** Header/env pair; omit both for an unauthenticated server. */
  authHeaderName?: string;
  authEnvVar?: string;
  status?: McpServerStatus;
}

/**
 * Update semantics are patch-like: omitted fields keep their stored value, so
 * the auth pair is replaced by providing both names and cleared only by an
 * explicit clearAuth — never by omitting them.
 */
export interface McpServerUpdateInput {
  name: string;
  description: string;
  endpointUrl: string;
  authHeaderName?: string;
  authEnvVar?: string;
  clearAuth?: boolean;
  status?: McpServerStatus;
}

export type McpServerMutationInput = McpServerCreateInput | McpServerUpdateInput;

/**
 * Why a tool can or cannot be called by a governed run. `registered` is the only
 * usable state; `disabled` is the admin's own switch; the rest mean the tool is
 * enabled but a precondition is still missing.
 *
 * Mirrors MCP_TOOL_ACTIVATION_STATES in apps/server/src/mcp/mcp.tooling.ts —
 * keep the two lists in step; the admin renders one i18n key per value.
 */
export type McpToolActivation =
  | "registered"
  | "disabled"
  | "server_disabled"
  | "invalid_capability_id"
  | "permissions_required"
  | "unknown_permissions"
  | "registration_pending";

export interface McpTool {
  id: string;
  serverId: string;
  name: string;
  description: string;
  risk: McpToolRisk;
  requiredPermissions: string[];
  enabled: boolean;
  activation: McpToolActivation;
  createdAt?: string;
  updatedAt?: string;
}

export interface McpToolListResponse {
  items: McpTool[];
}

export interface McpToolMutationInput {
  risk?: McpToolRisk;
  requiredPermissions?: string[];
  enabled?: boolean;
}

export interface McpSyncOutcome {
  added: number;
  updated: number;
  removed: string[];
}

export interface McpServerAccess {
  canManage: boolean;
}
