export const CORE_PERMISSIONS = [
  { resource: "users", action: "read", description: "View users" },
  { resource: "users", action: "create", description: "Create users" },
  { resource: "users", action: "assign-roles", description: "Replace user role assignments" },
  { resource: "roles", action: "read", description: "View roles" },
  { resource: "agents", action: "read", description: "View agents" },
  { resource: "agents", action: "create", description: "Create agents" },
  { resource: "agents", action: "update", description: "Update agents" },
  { resource: "agents", action: "assign-roles", description: "Replace agent role assignments" },
  {
    resource: "agents",
    action: "assign-permissions",
    description: "Replace direct agent permission assignments",
  },
  { resource: "permissions", action: "read", description: "View permission catalog" },
] as const;
