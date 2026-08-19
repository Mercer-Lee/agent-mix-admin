import { AgentSpecSchema, type AgentSpec } from "@agentmix/core";

export interface AgentDefinition {
  readonly spec: AgentSpec;
  readonly createdAt: string;
}

/**
 * Entry point for defining agents in code (Phase 2 will extend this into a full
 * definition carrying a runtime adapter). Input is validated immediately with
 * AgentSpecSchema so invalid definitions fail at definition time, not after publish.
 */
export function defineAgent(spec: AgentSpec): AgentDefinition {
  return { spec: AgentSpecSchema.parse(spec), createdAt: new Date().toISOString() };
}
