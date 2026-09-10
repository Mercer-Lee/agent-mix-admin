import { z } from "zod";

/**
 * Capability ids use module.action format. The action segment admits
 * underscores so a registered MCP tool name (RFC: [a-z0-9_-]) can be embedded
 * verbatim, e.g. "mcp-github.create_issue".
 */
export const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/;
const MODULE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

export const CapabilityRiskSchema = z.enum(["read", "sensitive_read", "write", "critical"]);

export const CapabilityManifestSchema = z.object({
  id: z.string().regex(CAPABILITY_ID_PATTERN, "capability id must use module.action format"),
  version: z.string().regex(SEMVER_PATTERN, "capability version must be a semantic version"),
  module: z.string().regex(MODULE_ID_PATTERN, "module must be a kebab-case identifier"),
  description: z.string().trim().min(1).max(500),
  risk: CapabilityRiskSchema,
  requiredPermissions: z.array(z.string().regex(PERMISSION_PATTERN)).min(1),
});

export const CapabilityExecutionContextSchema = z.object({
  actorSubjectId: z.uuid(),
  agentSubjectId: z.uuid(),
  traceId: z.string().trim().min(1).max(128),
  conversationId: z.string().trim().min(1).max(128).optional(),
});

const JsonSchemaSchema = z.record(z.string(), z.unknown());

export const CapabilityDescriptorSchema = CapabilityManifestSchema.extend({
  inputSchema: JsonSchemaSchema,
  outputSchema: JsonSchemaSchema,
});

export const CAPABILITY_ERROR_CODES = [
  "CAPABILITY_NOT_FOUND",
  "CAPABILITY_FORBIDDEN",
  "CAPABILITY_INPUT_INVALID",
  "CAPABILITY_OUTPUT_INVALID",
  "CAPABILITY_EXECUTION_FAILED",
] as const;

export const CapabilityErrorCodeSchema = z.enum(CAPABILITY_ERROR_CODES);

export type CapabilityRisk = z.infer<typeof CapabilityRiskSchema>;
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;
export type CapabilityExecutionContext = z.infer<typeof CapabilityExecutionContextSchema>;
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;
export type CapabilityErrorCode = z.infer<typeof CapabilityErrorCodeSchema>;

export class CapabilityError extends Error {
  constructor(
    public readonly code: CapabilityErrorCode,
    message: string,
    public readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CapabilityError";
  }
}
