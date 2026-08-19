import { AgentSpecSchema, type AgentSpec } from "@agentmix/core";

export interface AgentDefinition {
  readonly spec: AgentSpec;
  readonly createdAt: string;
}

/**
 * 代码态定义 Agent 的入口（Phase 2 将扩展为携带运行时适配器的完整定义）。
 * 输入立即用 AgentSpecSchema 校验，非法定义在定义期即失败，而不是发布后。
 */
export function defineAgent(spec: AgentSpec): AgentDefinition {
  return { spec: AgentSpecSchema.parse(spec), createdAt: new Date().toISOString() };
}
