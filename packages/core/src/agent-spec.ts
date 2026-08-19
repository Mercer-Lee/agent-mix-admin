import { z } from "zod";

/**
 * Agent Spec — declarative agent definitions.
 * Agents are first-class enterprise resources governed by RBAC in this framework
 * (see docs/architecture.md, pillar 1). This schema is its minimal kernel:
 * model, system prompt, MCP tool references, and visibility permissions.
 */
export const McpToolRefSchema = z.object({
  /** MCP server identifier (the server id registered in the Admin tool registry) */
  server: z.string().min(1),
  /** Optional: expose only a subset of the server's tools; defaults to all */
  tools: z.array(z.string().min(1)).optional(),
});

export const AgentPermissionsSchema = z.object({
  /** Roles allowed to use this agent */
  roles: z.array(z.string().min(1)),
  /** Departments that can see this agent */
  departments: z.array(z.string().min(1)),
});

export const AgentSpecSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "agent id must be a kebab-case slug"),
  name: z.string().min(1),
  description: z.string(),
  /** Model identifier routed through the model gateway, e.g. "openai/gpt-4o", "deepseek/deepseek-chat" */
  model: z.string().min(1),
  systemPrompt: z.string(),
  tools: z.array(McpToolRefSchema),
  permissions: AgentPermissionsSchema,
});

export type McpToolRef = z.infer<typeof McpToolRefSchema>;
export type AgentPermissions = z.infer<typeof AgentPermissionsSchema>;
export type AgentSpec = z.infer<typeof AgentSpecSchema>;
