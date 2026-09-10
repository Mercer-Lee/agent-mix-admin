import { z } from "zod";
import {
  CAPABILITY_ERROR_CODES,
  CAPABILITY_ID_PATTERN,
} from "./capability";
import {
  UsersSearchInputV1Schema,
  UsersSearchOutputV1Schema,
  type UsersSearchInputV1,
} from "./users-search";

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const TraceIdSchema = z.string().trim().min(1).max(128);

/**
 * Durable conversation history and terminal Runtime events share this exact
 * character boundary. The Worker truncates provider output at this limit so a
 * completed answer can always be reused in the next immutable run snapshot.
 */
export const AGENT_RUN_MESSAGE_MAX_CHARS = 32_000;

/** Upper bound on tools/capabilities carried by a single run snapshot. */
export const AGENT_RUN_MAX_TOOLS = 32;

/**
 * Model-facing tool names follow the OpenAI-compatible function-name charset:
 * letters, digits, underscore and hyphen only, at most 64 characters. Capability
 * ids never satisfy this (they always carry a module separator), so they are
 * mapped through deriveProviderToolName.
 */
const RUNTIME_TOOL_NAME_MAX_CHARS = 64;
const RUNTIME_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** Characters of the capability id hashed into a derived provider tool name. */
const DERIVED_TOOL_SUFFIX_CHARS = 8;

/**
 * FNV-1a over the capability id. Not a security primitive: it only needs to be
 * stable across processes and to separate ids that would otherwise derive the
 * same provider name.
 */
function capabilityIdDigest(capabilityId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < capabilityId.length; index += 1) {
    hash ^= capabilityId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(DERIVED_TOOL_SUFFIX_CHARS, "0");
}

/**
 * Provider-facing name for a governed capability id. The remote tool name stays
 * readable and a digest of the full id is appended, so two servers exposing the
 * same tool name ("search") can never collapse into one provider function — the
 * Worker keys its tool set by this name. Capability ids always carry a module
 * separator, which no provider accepts in a function name, so every id is
 * mapped rather than passed through.
 */
export function deriveProviderToolName(capabilityId: string): string {
  // Kept for callers that already hold a provider-safe name.
  if (capabilityId.length <= RUNTIME_TOOL_NAME_MAX_CHARS &&
      RUNTIME_TOOL_NAME_PATTERN.test(capabilityId)) {
    return capabilityId;
  }
  const separator = capabilityId.lastIndexOf(".");
  const action = separator === -1 ? capabilityId : capabilityId.slice(separator + 1);
  const suffix = `-${capabilityIdDigest(capabilityId)}`;
  const prefixChars = RUNTIME_TOOL_NAME_MAX_CHARS - suffix.length;
  return `${action.slice(0, prefixChars)}${suffix}`;
}

export const RuntimeContractVersionV1Schema = z.literal(1);
export const DefaultModelConnectionV1Schema = z.literal("default");
export const RuntimeCapabilityIdV1Schema = z
  .string()
  .regex(CAPABILITY_ID_PATTERN, "capability id must use module.action format");

export type RuntimeJsonV1 =
  | string
  | number
  | boolean
  | null
  | RuntimeJsonV1[]
  | { [key: string]: RuntimeJsonV1 };

const RuntimeJsonV1Schema: z.ZodType<RuntimeJsonV1> = z.json();
export const RuntimeJsonSchemaV1Schema = z
  .record(z.string(), z.unknown())
  .refine((value) => {
    try {
      JSON.stringify(value);
      return true;
    } catch {
      return false;
    }
  }, "input schema must be JSON-serializable");

/**
 * Model-facing descriptor for one callable tool. `id` is the governed
 * capability id; `name` is the provider-facing function name; `inputSchema` is
 * a JSON Schema (draft 2020-12) the Worker hands to the AI SDK verbatim.
 */
export const RuntimeToolDescriptorV1Schema = z
  .object({
    id: RuntimeCapabilityIdV1Schema,
    name: z.string().regex(RUNTIME_TOOL_NAME_PATTERN),
    description: z.string().trim().min(1).max(2_000),
    inputSchema: RuntimeJsonSchemaV1Schema,
  })
  .strict();

export const AgentRunMessageV1Schema = z.discriminatedUnion("role", [
  z
    .object({
      id: z.uuid(),
      role: z.literal("user"),
      content: z.string().min(1).max(AGENT_RUN_MESSAGE_MAX_CHARS),
    })
    .strict(),
  z
    .object({
      id: z.uuid(),
      role: z.literal("assistant"),
      content: z.string().max(AGENT_RUN_MESSAGE_MAX_CHARS),
    })
    .strict(),
]);

export const AgentRunModelV1Schema = z
  .object({
    profileId: z.uuid(),
    key: z.string().trim().min(1).max(100),
    modelId: z.string().trim().min(1).max(200),
    connectionId: DefaultModelConnectionV1Schema,
  })
  .strict();

export const AgentRunGenerationV1Schema = z
  .object({
    temperature: z.number().min(0).max(2),
    maxOutputTokens: z.number().int().min(1).max(32_768),
    maxSteps: z.number().int().min(1).max(5),
  })
  .strict();

/** Immutable execution snapshot dispatched to the Runtime. It never contains credentials or a base URL. */
export const AgentRunTaskV1Schema = z
  .object({
    version: RuntimeContractVersionV1Schema,
    kind: z.literal("agent.run"),
    runId: z.uuid(),
    conversationId: z.uuid(),
    actorSubjectId: z.uuid(),
    agentSubjectId: z.uuid(),
    traceId: TraceIdSchema,
    model: AgentRunModelV1Schema,
    generation: AgentRunGenerationV1Schema,
    systemPrompt: z.string().max(32_000),
    messages: z.array(AgentRunMessageV1Schema).min(1),
    capabilities: z.array(RuntimeCapabilityIdV1Schema).max(AGENT_RUN_MAX_TOOLS),
    /**
     * Model-facing tool set. Always present in snapshots produced by the
     * current control plane; optional so pre-2A snapshots stored in durable
     * agent_runs rows keep parsing during rolling upgrades and stall replays.
     */
    tools: z.array(RuntimeToolDescriptorV1Schema).max(AGENT_RUN_MAX_TOOLS).optional(),
    createdAt: IsoDateTimeSchema,
    deadlineAt: IsoDateTimeSchema,
  })
  .strict();

export const ModelCheckTaskV1Schema = z
  .object({
    version: RuntimeContractVersionV1Schema,
    kind: z.literal("model.check"),
    checkId: z.uuid(),
    modelProfileId: z.uuid(),
    modelId: z.string().trim().min(1).max(200),
    connectionId: DefaultModelConnectionV1Schema,
    requestedAt: IsoDateTimeSchema,
    deadlineAt: IsoDateTimeSchema,
  })
  .strict();

export const RuntimeTaskV1Schema = z.discriminatedUnion("kind", [
  AgentRunTaskV1Schema,
  ModelCheckTaskV1Schema,
]);

export const ModelUsageV1Schema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    cachedInputTokens: z.number().int().nonnegative().nullable().optional(),
    reasoningTokens: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export const AgentRunFinishReasonV1Schema = z.enum([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "other",
  "unknown",
]);

export const RuntimeSafeErrorCodeV1Schema = z.enum([
  "provider_authentication",
  "provider_rate_limited",
  "provider_timeout",
  "provider_unavailable",
  "provider_invalid_response",
  "capability_failed",
  "deadline_exceeded",
  "cancelled",
  "unknown",
]);

const AgentRunEventBaseV1Schema = z.object({
  version: RuntimeContractVersionV1Schema,
  kind: z.literal("agent.run.event"),
  eventId: z.uuid(),
  runId: z.uuid(),
  conversationId: z.uuid(),
  attempt: z.number().int().min(1).max(2),
  sequence: z.number().int().min(1),
  occurredAt: IsoDateTimeSchema,
});

const AgentRunStartedEventV1Schema = AgentRunEventBaseV1Schema.extend({
  type: z.literal("run.started"),
}).strict();

const AgentRunResetEventV1Schema = AgentRunEventBaseV1Schema.extend({
  type: z.literal("run.reset"),
  reason: z.literal("retry"),
}).strict();

const AgentRunTextDeltaEventV1Schema = AgentRunEventBaseV1Schema.extend({
  type: z.literal("text.delta"),
  delta: z.string().min(1).max(AGENT_RUN_MESSAGE_MAX_CHARS),
}).strict();

const AgentRunCapabilityStartedEventV1Schema = AgentRunEventBaseV1Schema.extend({
  type: z.literal("capability.started"),
  requestId: z.uuid(),
  capability: RuntimeCapabilityIdV1Schema,
}).strict();

const AgentRunCapabilityCompletedEventV1Schema = AgentRunEventBaseV1Schema.extend({
  type: z.literal("capability.completed"),
  requestId: z.uuid(),
  capability: RuntimeCapabilityIdV1Schema,
  resultCount: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
}).strict();

const AgentRunCapabilityFailedEventV1Schema = AgentRunEventBaseV1Schema.extend({
  type: z.literal("capability.failed"),
  requestId: z.uuid(),
  capability: RuntimeCapabilityIdV1Schema,
  errorCode: RuntimeSafeErrorCodeV1Schema,
}).strict();

const AgentRunCompletedEventV1Schema = AgentRunEventBaseV1Schema.extend({
  type: z.literal("run.completed"),
  text: z.string().max(AGENT_RUN_MESSAGE_MAX_CHARS),
  finishReason: AgentRunFinishReasonV1Schema,
  usage: ModelUsageV1Schema,
}).strict();

const AgentRunFailedEventV1Schema = AgentRunEventBaseV1Schema.extend({
  type: z.literal("run.failed"),
  errorCode: RuntimeSafeErrorCodeV1Schema,
  retryable: z.boolean(),
}).strict();

const AgentRunCancelledEventV1Schema = AgentRunEventBaseV1Schema.extend({
  type: z.literal("run.cancelled"),
  reason: z.literal("requested"),
}).strict();

export const AgentRunEventV1Schema = z.discriminatedUnion("type", [
  AgentRunStartedEventV1Schema,
  AgentRunResetEventV1Schema,
  AgentRunTextDeltaEventV1Schema,
  AgentRunCapabilityStartedEventV1Schema,
  AgentRunCapabilityCompletedEventV1Schema,
  AgentRunCapabilityFailedEventV1Schema,
  AgentRunCompletedEventV1Schema,
  AgentRunFailedEventV1Schema,
  AgentRunCancelledEventV1Schema,
]);

const ModelCheckEventBaseV1Schema = z.object({
  version: RuntimeContractVersionV1Schema,
  kind: z.literal("model.check.event"),
  eventId: z.uuid(),
  checkId: z.uuid(),
  modelProfileId: z.uuid(),
  sequence: z.number().int().min(1),
  occurredAt: IsoDateTimeSchema,
});

const ModelCheckStartedEventV1Schema = ModelCheckEventBaseV1Schema.extend({
  type: z.literal("model.check.started"),
  status: z.literal("running"),
}).strict();

const ModelCheckCompletedEventV1Schema = ModelCheckEventBaseV1Schema.extend({
  type: z.literal("model.check.completed"),
  status: z.literal("succeeded"),
  latencyMs: z.number().int().nonnegative(),
  usage: ModelUsageV1Schema,
}).strict();

const ModelCheckFailedEventV1Schema = ModelCheckEventBaseV1Schema.extend({
  type: z.literal("model.check.failed"),
  status: z.literal("failed"),
  latencyMs: z.number().int().nonnegative(),
  usage: ModelUsageV1Schema.nullable(),
  errorCode: RuntimeSafeErrorCodeV1Schema,
}).strict();

export const ModelCheckEventV1Schema = z.discriminatedUnion("type", [
  ModelCheckStartedEventV1Schema,
  ModelCheckCompletedEventV1Schema,
  ModelCheckFailedEventV1Schema,
]);

export const RuntimeEventV1Schema = z.union([AgentRunEventV1Schema, ModelCheckEventV1Schema]);

const CapabilityRequestBaseV1Schema = z.object({
  version: RuntimeContractVersionV1Schema,
  kind: z.literal("capability.request"),
  requestId: z.uuid(),
  runId: z.uuid(),
  conversationId: z.uuid(),
  actorSubjectId: z.uuid(),
  agentSubjectId: z.uuid(),
  traceId: TraceIdSchema,
  requestedAt: IsoDateTimeSchema,
  deadlineAt: IsoDateTimeSchema,
});

/**
 * The users.search vertical keeps its typed input/output at the contract
 * boundary; every other capability (including registered MCP tools) carries
 * JSON values that the control-plane CapabilityExecutor validates against the
 * capability's registered schemas before execution. The generic branch
 * explicitly rejects "users.search" so an ill-typed users.search request
 * cannot fall through with a lenient JSON input.
 */
const CapabilityRequestShapeSchema = CapabilityRequestBaseV1Schema.extend({
  capability: RuntimeCapabilityIdV1Schema,
  input: RuntimeJsonV1Schema,
}).strict();

/**
 * The envelope every capability request must satisfy, extended below by the
 * users.search vertical. `input` is typed as plain JSON here; the literal
 * branch narrows it below.
 */
interface CapabilityRequestEnvelopeV1
  extends z.infer<typeof CapabilityRequestBaseV1Schema> {
  capability: string;
  input: RuntimeJsonV1;
}

/**
 * Note on the type: `capability` and `input` are deliberately *not* correlated.
 * Expressing "the users.search literal selects the typed payload, every other
 * id selects generic JSON" needs `z.discriminatedUnion`, which cannot be used
 * here because the generic branch is an open string pattern rather than a
 * literal. A hand-written union does not help either: TypeScript matches
 * `{ capability: "users.search"; input: … }` against the open `capability:
 * string` member first and accepts any JSON, so the constraint would only look
 * enforced. The guarantee lives in the schema instead, where it is tested:
 * this type admits any capability request, and
 * CapabilityRequestV1Schema.parse is what rejects an ill-typed users.search
 * payload at every real construction site.
 */
export type CapabilityRequestV1 = CapabilityRequestEnvelopeV1;

export const CapabilityRequestV1Schema = z
  .unknown()
  .superRefine((value, ctx) => {
    const envelope = CapabilityRequestShapeSchema.safeParse(value);
    if (!envelope.success) {
      for (const issue of envelope.error.issues) {
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
      }
      return;
    }
    if (envelope.data.capability !== "users.search") return;
    const input = UsersSearchInputV1Schema.safeParse(envelope.data.input);
    if (!input.success) {
      for (const issue of input.error.issues) {
        ctx.addIssue({ code: "custom", path: ["input", ...issue.path], message: issue.message });
      }
      return;
    }
    // Propagate the parsed payload: UsersSearchInputV1Schema supplies defaults
    // that a re-parse of the raw value in transform() would drop.
    ctx.value = { ...envelope.data, input: input.data };
  })
  .transform((value): CapabilityRequestV1 => {
    const request = CapabilityRequestShapeSchema.parse(value);
    if (request.capability === "users.search") {
      return { ...request, input: UsersSearchInputV1Schema.parse(request.input) };
    }
    return request;
  });

export const CapabilityResultV1Schema = z.discriminatedUnion("status", [
  z
    .object({
      version: RuntimeContractVersionV1Schema,
      kind: z.literal("capability.result"),
      requestId: z.uuid(),
      status: z.literal("completed"),
      output: z.union([UsersSearchOutputV1Schema, RuntimeJsonV1Schema]),
      completedAt: IsoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      version: RuntimeContractVersionV1Schema,
      kind: z.literal("capability.result"),
      requestId: z.uuid(),
      status: z.literal("failed"),
      errorCode: z.enum([
        ...CAPABILITY_ERROR_CODES,
        "CAPABILITY_TIMEOUT",
        "CAPABILITY_CANCELLED",
        "CAPABILITY_INTERNAL",
      ]),
      completedAt: IsoDateTimeSchema,
    })
    .strict(),
]);

export const AgentRunControlV1Schema = z
  .object({
    version: RuntimeContractVersionV1Schema,
    kind: z.literal("agent.run.cancel"),
    runId: z.uuid(),
    requestedAt: IsoDateTimeSchema,
  })
  .strict();

/** Persistent control-plane outbox payloads, including non-Worker control messages. */
export const RuntimeOutboxMessageV1Schema = z.union([
  RuntimeTaskV1Schema,
  AgentRunControlV1Schema,
]);

export type AgentRunTaskV1 = z.infer<typeof AgentRunTaskV1Schema>;
export type RuntimeToolDescriptorV1 = z.infer<typeof RuntimeToolDescriptorV1Schema>;
export type RuntimeJsonV1Value = RuntimeJsonV1;
export type ModelCheckTaskV1 = z.infer<typeof ModelCheckTaskV1Schema>;
export type RuntimeTaskV1 = z.infer<typeof RuntimeTaskV1Schema>;
export type AgentRunEventV1 = z.infer<typeof AgentRunEventV1Schema>;
export type ModelCheckEventV1 = z.infer<typeof ModelCheckEventV1Schema>;
export type RuntimeEventV1 = z.infer<typeof RuntimeEventV1Schema>;
export type ModelUsageV1 = z.infer<typeof ModelUsageV1Schema>;
export type RuntimeSafeErrorCodeV1 = z.infer<typeof RuntimeSafeErrorCodeV1Schema>;
export type CapabilityResultV1 = z.infer<typeof CapabilityResultV1Schema>;
export type AgentRunControlV1 = z.infer<typeof AgentRunControlV1Schema>;
export type RuntimeOutboxMessageV1 = z.infer<typeof RuntimeOutboxMessageV1Schema>;
