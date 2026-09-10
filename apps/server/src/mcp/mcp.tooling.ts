import Ajv from "ajv";
import { CAPABILITY_ID_PATTERN, type CapabilityRisk } from "@agentmix/core";
import { z } from "zod";

/**
 * MCP tool input/output schemas are plain JSON Schema documents advertised by
 * the remote server, so Ajv (not Zod) validates values against them. The Zod
 * wrapper below lets these tools flow through the same CapabilityExecutor
 * pipeline as code-defined capabilities.
 */
const ajv = new Ajv({
  // Tool schemas may use any JSON Schema dialect; validate values leniently
  // and never register compiled schemas globally (ids can collide across servers).
  strict: false,
  validateSchema: false,
  addUsedSchema: false,
});

export const MCP_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export const MCP_TOOL_CAPABILITY_VERSION = "1.0.0";

export const MCP_MODULE_PREFIX = "mcp-";

/** Safe, bounded error codes persisted on mcp_servers.last_sync_error_code. */
export const MCP_SYNC_ERROR_CODES = [
  "CONNECT_FAILED",
  "AUTH_ENV_MISSING",
  "TIMEOUT",
  "INVALID_INPUT_SCHEMA",
  "PROTOCOL_ERROR",
] as const;

/** Per-tool reasons recorded in the sync outcome instead of failing the whole sync. */
export type McpToolRejectionReason = "TOOL_NAME_INVALID" | "TOOL_NAME_CONFLICT";

export type McpSyncErrorCode = (typeof MCP_SYNC_ERROR_CODES)[number];

export function deriveMcpCapabilityId(serverSlug: string, toolName: string): string | null {
  const id = `${MCP_MODULE_PREFIX}${serverSlug}.${toolName.toLowerCase()}`;
  return CAPABILITY_ID_PATTERN.test(id) ? id : null;
}

export function deriveMcpModule(serverSlug: string): string {
  return `${MCP_MODULE_PREFIX}${serverSlug}`;
}

/**
 * Compile-time validated tool name / id pairs shared by sync and snapshot
 * building. Pure and exported for unit tests.
 */
export function validateDiscoveredToolName(name: string): boolean {
  return MCP_TOOL_NAME_PATTERN.test(name);
}

export function isValidJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

const jsonSchemaIssueMessage = "value does not match the capability JSON schema";

export function createJsonSchemaValidator(schema: Record<string, unknown>): z.ZodType<unknown> {
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schema);
  } catch {
    // A schema that cannot compile rejects every value instead of opening a
    // validation bypass; sync marks the tool invalid before it can be enabled.
    return z.unknown().superRefine((_value, ctx) => {
      ctx.addIssue({ code: "custom", message: "capability schema is invalid" });
    });
  }
  return z.unknown().superRefine((value, ctx) => {
    if (validate(value)) return;
    const firstMessage = validate.errors?.[0]?.message ?? jsonSchemaIssueMessage;
    ctx.addIssue({ code: "custom", message: `${jsonSchemaIssueMessage}: ${firstMessage}` });
  });
}

/** Accepts any JSON value — used for MCP tools that advertise no output schema. */
export const jsonValueSchema: z.ZodType<unknown> = z.json();

export interface McpCapabilityManifestInput {
  id: string;
  serverSlug: string;
  description: string;
  risk: CapabilityRisk;
  requiredPermissions: string[];
}
