import { z } from "zod";

/**
 * Agent Spec —— 声明式 Agent 定义。
 * Agent 在本框架中是被 RBAC 管理的一等企业资源（见 docs/architecture.md 支柱一），
 * 本 schema 是其最小内核：模型、系统提示词、MCP 工具引用、可见性权限。
 */
export const McpToolRefSchema = z.object({
  /** MCP server 标识（在 Admin 工具注册表中登记的 server id） */
  server: z.string().min(1),
  /** 可选：仅暴露 server 中的部分工具；缺省暴露全部 */
  tools: z.array(z.string().min(1)).optional(),
});

export const AgentPermissionsSchema = z.object({
  /** 可使用该 Agent 的角色 */
  roles: z.array(z.string().min(1)),
  /** 可见该 Agent 的部门 */
  departments: z.array(z.string().min(1)),
});

export const AgentSpecSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "agent id 必须是 kebab-case slug"),
  name: z.string().min(1),
  description: z.string(),
  /** 模型标识，经模型网关路由，如 "openai/gpt-4o"、"deepseek/deepseek-chat" */
  model: z.string().min(1),
  systemPrompt: z.string(),
  tools: z.array(McpToolRefSchema),
  permissions: AgentPermissionsSchema,
});

export type McpToolRef = z.infer<typeof McpToolRefSchema>;
export type AgentPermissions = z.infer<typeof AgentPermissionsSchema>;
export type AgentSpec = z.infer<typeof AgentSpecSchema>;
