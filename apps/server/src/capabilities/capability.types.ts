import type { CapabilityExecutionContext, CapabilityManifest } from "@agentmix/core";
import type { z } from "zod";

export interface CapabilityAuditProjection<Input, Output> {
  input?: (input: Input) => Record<string, unknown>;
  output?: (output: Output) => Record<string, unknown>;
}

export interface RegisteredCapability<Input = unknown, Output = unknown> {
  manifest: CapabilityManifest;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  execute: (input: Input, context: CapabilityExecutionContext) => Promise<Output>;
  audit?: CapabilityAuditProjection<Input, Output>;
}

export type AnyRegisteredCapability = RegisteredCapability<any, any>;

export function defineCapability<Input, Output>(
  capability: RegisteredCapability<Input, Output>,
): RegisteredCapability<Input, Output> {
  return capability;
}
