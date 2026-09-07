import { z } from "zod";
import { CAPABILITY_ERROR_CODES } from "./capability";
import { UsersSearchInputV1Schema, UsersSearchOutputV1Schema } from "./users-search";

const IsoDateTimeSchema = z.string().datetime({ offset: true });
const TraceIdSchema = z.string().trim().min(1).max(128);

/**
 * Durable conversation history and terminal Runtime events share this exact
 * character boundary. The Worker truncates provider output at this limit so a
 * completed answer can always be reused in the next immutable run snapshot.
 */
export const AGENT_RUN_MESSAGE_MAX_CHARS = 32_000;

export const RuntimeContractVersionV1Schema = z.literal(1);
export const DefaultModelConnectionV1Schema = z.literal("default");
export const RuntimeCapabilityIdV1Schema = z.literal("users.search");

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
    capabilities: z.array(RuntimeCapabilityIdV1Schema).max(1),
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

export const CapabilityRequestV1Schema = CapabilityRequestBaseV1Schema.extend({
  capability: z.literal("users.search"),
  input: UsersSearchInputV1Schema,
}).strict();

export const CapabilityResultV1Schema = z.discriminatedUnion("status", [
  z
    .object({
      version: RuntimeContractVersionV1Schema,
      kind: z.literal("capability.result"),
      requestId: z.uuid(),
      status: z.literal("completed"),
      output: UsersSearchOutputV1Schema,
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
export type ModelCheckTaskV1 = z.infer<typeof ModelCheckTaskV1Schema>;
export type RuntimeTaskV1 = z.infer<typeof RuntimeTaskV1Schema>;
export type AgentRunEventV1 = z.infer<typeof AgentRunEventV1Schema>;
export type ModelCheckEventV1 = z.infer<typeof ModelCheckEventV1Schema>;
export type RuntimeEventV1 = z.infer<typeof RuntimeEventV1Schema>;
export type ModelUsageV1 = z.infer<typeof ModelUsageV1Schema>;
export type RuntimeSafeErrorCodeV1 = z.infer<typeof RuntimeSafeErrorCodeV1Schema>;
export type CapabilityRequestV1 = z.infer<typeof CapabilityRequestV1Schema>;
export type CapabilityResultV1 = z.infer<typeof CapabilityResultV1Schema>;
export type AgentRunControlV1 = z.infer<typeof AgentRunControlV1Schema>;
export type RuntimeOutboxMessageV1 = z.infer<typeof RuntimeOutboxMessageV1Schema>;
