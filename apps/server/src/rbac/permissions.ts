export const PHASE_1A_PERMISSIONS = [
  { resource: "users", action: "read", description: "View users" },
  { resource: "users", action: "create", description: "Create users" },
  { resource: "users", action: "assign-roles", description: "Replace user role assignments" },
  { resource: "roles", action: "read", description: "View roles" },
] as const;
