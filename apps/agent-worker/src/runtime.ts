import { randomUUID } from "node:crypto";
import { createOpenAICompatible, type OpenAICompatibleProvider } from "@ai-sdk/openai-compatible";
import {
  AGENT_RUN_MESSAGE_MAX_CHARS,
  AgentRunEventV1Schema,
  CapabilityResultV1Schema,
  ModelCheckEventV1Schema,
  type AgentRunEventV1,
  type AgentRunTaskV1,
  type CapabilityRequestV1,
  type CapabilityResultV1,
  type ModelCheckEventV1,
  type ModelCheckTaskV1,
  type ModelUsageV1,
  type RuntimeEventV1,
  type RuntimeToolDescriptorV1,
  UsersSearchInputV1Schema,
  UsersSearchOutputV1Schema,
} from "@agentmix/core";
import {
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { CapabilityBridgeError, classifyRuntimeError } from "./safe-errors";

const MAX_ATTEMPTS = 2;
const DEFAULT_RUN_DEADLINE_MS = 120_000;
const DEFAULT_CHECK_DEADLINE_MS = 30_000;
const DEFAULT_DELTA_FLUSH_MS = 75;
const DEFAULT_DELTA_MAX_CHARS = 256;

export interface RuntimeEventSink {
  publish(event: RuntimeEventV1): Promise<void>;
}

export interface RuntimeCapabilityClient {
  execute(request: CapabilityRequestV1, signal: AbortSignal): Promise<CapabilityResultV1>;
}

export class RuntimeEventDeliveryError extends Error {
  constructor(options?: ErrorOptions) {
    super("Runtime event delivery failed", options);
    this.name = "RuntimeEventDeliveryError";
  }
}

export interface AgentRuntimeOptions {
  provider: OpenAICompatibleProvider;
  events: RuntimeEventSink;
  capabilities: RuntimeCapabilityClient;
  runDeadlineMs?: number;
  checkDeadlineMs?: number;
  deltaFlushMs?: number;
  deltaMaxChars?: number;
  now?: () => number;
  createId?: () => string;
}

type AgentEventPayload = AgentRunEventV1 extends infer Event
  ? Event extends AgentRunEventV1
    ? Omit<
        Event,
        | "version"
        | "kind"
        | "eventId"
        | "runId"
        | "conversationId"
        | "attempt"
        | "sequence"
        | "occurredAt"
      >
    : never
  : never;

type ModelCheckEventPayload = ModelCheckEventV1 extends infer Event
  ? Event extends ModelCheckEventV1
    ? Omit<
        Event,
        | "version"
        | "kind"
        | "eventId"
        | "checkId"
        | "modelProfileId"
        | "sequence"
        | "occurredAt"
      >
    : never
  : never;

interface AttemptResult {
  text: string;
  finishReason: FinishReason | "unknown";
  usage: ModelUsageV1;
}

interface DeadlineContext {
  signal: AbortSignal;
  effectiveDeadlineAt: string;
  reason: () => "requested" | "deadline" | null;
  close: () => void;
}

class RunEventPublisher {
  private sequence = 0;

  constructor(
    private readonly task: AgentRunTaskV1,
    private readonly attempt: number,
    private readonly events: RuntimeEventSink,
    private readonly now: () => number,
    private readonly createId: () => string,
  ) {}

  async publish(payload: AgentEventPayload): Promise<void> {
    const event = AgentRunEventV1Schema.parse({
      version: 1,
      kind: "agent.run.event",
      eventId: this.createId(),
      runId: this.task.runId,
      conversationId: this.task.conversationId,
      attempt: this.attempt,
      sequence: ++this.sequence,
      occurredAt: new Date(this.now()).toISOString(),
      ...payload,
    });
    try {
      await this.events.publish(event);
    } catch (error) {
      throw new RuntimeEventDeliveryError({ cause: error });
    }
  }
}

class ModelCheckEventPublisher {
  private sequence = 0;

  constructor(
    private readonly task: ModelCheckTaskV1,
    private readonly events: RuntimeEventSink,
    private readonly now: () => number,
    private readonly createId: () => string,
  ) {}

  async publish(payload: ModelCheckEventPayload): Promise<void> {
    const event = ModelCheckEventV1Schema.parse({
      version: 1,
      kind: "model.check.event",
      eventId: this.createId(),
      checkId: this.task.checkId,
      modelProfileId: this.task.modelProfileId,
      sequence: ++this.sequence,
      occurredAt: new Date(this.now()).toISOString(),
      ...payload,
    });
    try {
      await this.events.publish(event);
    } catch (error) {
      throw new RuntimeEventDeliveryError({ cause: error });
    }
  }
}

class DeltaBatcher {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending = Promise.resolve();
  private failure: unknown;

  constructor(
    private readonly flushMs: number,
    private readonly maxChars: number,
    private readonly publish: (delta: string) => Promise<void>,
  ) {}

  push(delta: string): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (!delta) return this.waitForPending();
    this.buffer += delta;
    if (this.buffer.length >= this.maxChars) return this.flush();
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch(() => undefined);
      }, this.flushMs);
    }
    return this.waitForPending();
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.failure) return Promise.reject(this.failure);
    if (!this.buffer) return this.waitForPending();
    const delta = this.buffer;
    this.buffer = "";
    const operation = this.pending.then(() => this.publish(delta));
    this.pending = operation.then(
      () => undefined,
      (error: unknown) => {
        this.buffer = delta + this.buffer;
        this.failure = error;
      },
    );
    return operation;
  }

  private waitForPending(): Promise<void> {
    return this.pending.then(() => {
      if (this.failure) throw this.failure;
    });
  }
}

function isRuntimeEventDeliveryError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (current instanceof RuntimeEventDeliveryError) return true;
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

function emptyUsage(): ModelUsageV1 {
  return { inputTokens: null, outputTokens: null, totalTokens: null };
}

function mapUsage(usage: LanguageModelUsage | undefined): ModelUsageV1 {
  if (!usage) return emptyUsage();
  return {
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    totalTokens: usage.totalTokens ?? null,
    cachedInputTokens: usage.inputTokenDetails.cacheReadTokens ?? null,
    reasoningTokens: usage.outputTokenDetails.reasoningTokens ?? null,
  };
}

function normalizeFinishReason(
  reason: FinishReason | "unknown" | undefined,
): FinishReason | "unknown" {
  return reason ?? "unknown";
}

function createDeadline(
  requestedDeadlineAt: string,
  maximumDurationMs: number,
  externalSignal: AbortSignal | undefined,
  now: () => number,
): DeadlineContext {
  const controller = new AbortController();
  let abortReason: "requested" | "deadline" | null = null;
  const deadlineMs = Math.min(Date.parse(requestedDeadlineAt), now() + maximumDurationMs);
  const effectiveDeadlineAt = new Date(deadlineMs).toISOString();

  const abortFromRequest = () => {
    if (controller.signal.aborted) return;
    abortReason = "requested";
    controller.abort("requested");
  };
  externalSignal?.addEventListener("abort", abortFromRequest, { once: true });
  if (externalSignal?.aborted) abortFromRequest();

  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    abortReason = "deadline";
    controller.abort("deadline");
  }, Math.max(0, deadlineMs - now()));

  return {
    signal: controller.signal,
    effectiveDeadlineAt,
    reason: () => abortReason,
    close: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortFromRequest);
    },
  };
}

export function createDefaultProvider(apiKey: string, baseURL: string): OpenAICompatibleProvider {
  return createOpenAICompatible({
    name: "agentmix-default",
    apiKey,
    baseURL,
    includeUsage: true,
  });
}

export class AgentRuntime {
  private readonly runDeadlineMs: number;
  private readonly checkDeadlineMs: number;
  private readonly deltaFlushMs: number;
  private readonly deltaMaxChars: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.runDeadlineMs = options.runDeadlineMs ?? DEFAULT_RUN_DEADLINE_MS;
    this.checkDeadlineMs = options.checkDeadlineMs ?? DEFAULT_CHECK_DEADLINE_MS;
    this.deltaFlushMs = options.deltaFlushMs ?? DEFAULT_DELTA_FLUSH_MS;
    this.deltaMaxChars = options.deltaMaxChars ?? DEFAULT_DELTA_MAX_CHARS;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  async run(
    task: AgentRunTaskV1,
    externalSignal?: AbortSignal,
    startingAttempt: 1 | 2 = 1,
  ): Promise<"completed" | "failed" | "cancelled"> {
    const deadline = createDeadline(task.deadlineAt, this.runDeadlineMs, externalSignal, this.now);
    try {
      for (let attempt = startingAttempt; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const publisher = new RunEventPublisher(
          task,
          attempt,
          this.options.events,
          this.now,
          this.createId,
        );

        if (attempt > 1) await publisher.publish({ type: "run.reset", reason: "retry" });
        await publisher.publish({ type: "run.started" });

        if (deadline.signal.aborted) {
          if (deadline.reason() === "deadline") {
            await publisher.publish({
              type: "run.failed",
              errorCode: "deadline_exceeded",
              retryable: false,
            });
            return "failed";
          }
          await publisher.publish({ type: "run.cancelled", reason: "requested" });
          return "cancelled";
        }

        try {
          const result = await this.runAttempt(task, publisher, deadline);
          await publisher.publish({
            type: "run.completed",
            text: result.text,
            finishReason: normalizeFinishReason(result.finishReason),
            usage: result.usage,
          });
          return "completed";
        } catch (error) {
          if (isRuntimeEventDeliveryError(error)) throw error;
          if (deadline.signal.aborted) {
            if (deadline.reason() === "deadline") {
              await publisher.publish({
                type: "run.failed",
                errorCode: "deadline_exceeded",
                retryable: false,
              });
              return "failed";
            }
            await publisher.publish({ type: "run.cancelled", reason: "requested" });
            return "cancelled";
          }

          const classification = classifyRuntimeError(error);
          if (classification.retryable && attempt < MAX_ATTEMPTS) continue;
          await publisher.publish({
            type: "run.failed",
            errorCode: classification.code,
            retryable: classification.retryable,
          });
          return "failed";
        }
      }
      return "failed";
    } finally {
      deadline.close();
    }
  }

  async checkModel(task: ModelCheckTaskV1): Promise<"succeeded" | "failed"> {
    const publisher = new ModelCheckEventPublisher(
      task,
      this.options.events,
      this.now,
      this.createId,
    );
    const deadline = createDeadline(task.deadlineAt, this.checkDeadlineMs, undefined, this.now);
    await publisher.publish({ type: "model.check.started", status: "running" });
    const startedAt = this.now();

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
          const result = streamText({
            model: this.options.provider(task.modelId),
            prompt: "Reply with exactly OK.",
            maxOutputTokens: 4,
            maxRetries: 0,
            abortSignal: deadline.signal,
            // AI SDK logs the complete provider error by default. Runtime errors
            // are classified below and only the stable safe code is published.
            onError: () => undefined,
          });
          let firstTokenAt: number | undefined;
          let usage = emptyUsage();
          let sawText = false;
          for await (const part of result.fullStream) {
            if (part.type === "text-delta" && part.text) {
              sawText = true;
              firstTokenAt ??= this.now();
            } else if (part.type === "finish") {
              usage = mapUsage(part.totalUsage);
            } else if (part.type === "error" || part.type === "tool-error") {
              throw part.error;
            }
          }
          if (deadline.signal.aborted) throw new Error("model check aborted");
          if (!sawText || firstTokenAt === undefined) throw new Error("model check returned no text");
          await publisher.publish({
            type: "model.check.completed",
            status: "succeeded",
            latencyMs: Math.max(0, firstTokenAt - startedAt),
            usage,
          });
          return "succeeded";
        } catch (error) {
          if (isRuntimeEventDeliveryError(error)) throw error;
          const classification = deadline.signal.aborted
            ? { code: "deadline_exceeded" as const, retryable: false }
            : classifyRuntimeError(error);
          if (classification.retryable && attempt < MAX_ATTEMPTS) continue;
          await publisher.publish({
            type: "model.check.failed",
            status: "failed",
            latencyMs: Math.max(0, this.now() - startedAt),
            usage: null,
            errorCode: classification.code,
          });
          return "failed";
        }
      }
      return "failed";
    } finally {
      deadline.close();
    }
  }

  private async runAttempt(
    task: AgentRunTaskV1,
    publisher: RunEventPublisher,
    deadline: DeadlineContext,
  ): Promise<AttemptResult> {
    let text = "";
    let finishReason: FinishReason | "unknown" = "unknown";
    let usage = emptyUsage();
    let outputTruncated = false;
    const outputLimitController = new AbortController();
    const deltaBatcher = new DeltaBatcher(this.deltaFlushMs, this.deltaMaxChars, (delta) =>
      publisher.publish({ type: "text.delta", delta }),
    );

    const toolSet: ToolSet = {};
    for (const descriptor of task.tools ?? []) {
      toolSet[descriptor.name] = this.buildBridgeTool(task, descriptor, publisher, deadline, deltaBatcher);
    }
    if (Object.keys(toolSet).length === 0 && task.capabilities.includes("users.search")) {
      // Pre-2A durable snapshots (and rolling upgrades) carry capabilities
      // without descriptors; keep the vertical tool they may still invoke.
      toolSet.users_search = this.buildLegacyUsersSearchTool(task, publisher, deadline, deltaBatcher);
    }

    const messages: ModelMessage[] = task.messages.map(({ role, content }) => ({ role, content }));
    const result = streamText({
      model: this.options.provider(task.model.modelId),
      system: task.systemPrompt || undefined,
      messages,
      tools: Object.keys(toolSet).length > 0 ? toolSet : undefined,
      temperature: task.generation.temperature,
      maxOutputTokens: task.generation.maxOutputTokens,
      stopWhen: stepCountIs(Math.min(5, task.generation.maxSteps)),
      maxRetries: 0,
      abortSignal: AbortSignal.any([deadline.signal, outputLimitController.signal]),
      // Never let provider payloads, request bodies, headers, or endpoints reach
      // process logs. The full stream still carries the error for safe mapping.
      onError: () => undefined,
    });

    try {
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          const remaining = AGENT_RUN_MESSAGE_MAX_CHARS - text.length;
          if (part.text.length > remaining) {
            const accepted = part.text.slice(0, Math.max(0, remaining));
            if (accepted) {
              text += accepted;
              await deltaBatcher.push(accepted);
            }
            outputTruncated = true;
            outputLimitController.abort("output_limit");
            break;
          }
          text += part.text;
          await deltaBatcher.push(part.text);
        } else if (part.type === "finish") {
          finishReason = part.finishReason;
          usage = mapUsage(part.totalUsage);
        } else if (part.type === "error" || part.type === "tool-error") {
          throw part.error;
        } else if (part.type === "abort") {
          throw new Error("run aborted");
        }
      }
      await deltaBatcher.flush();
    } catch (error) {
      await deltaBatcher.flush();
      throw error;
    }

    if (deadline.signal.aborted) throw new Error("run aborted");
    if (outputTruncated) finishReason = "length";
    return { text, finishReason, usage };
  }

  /**
   * Build the provider tool for one snapshot descriptor. Every call routes
   * through the capability bridge back to the control plane, which owns
   * authorization, schema validation, and audit.
   */
  private buildBridgeTool(
    task: AgentRunTaskV1,
    descriptor: RuntimeToolDescriptorV1,
    publisher: RunEventPublisher,
    deadline: DeadlineContext,
    deltaBatcher: DeltaBatcher,
  ) {
    return tool({
      description: descriptor.description,
      // The control plane validates this input with the capability's own
      // registered schema (Ajv for MCP tools), so the Worker deliberately skips
      // client-side validation: no `validate` is passed, which makes the AI SDK
      // forward the remote schema verbatim instead of re-deriving constraints.
      inputSchema: jsonSchema(descriptor.inputSchema),
      execute: async (input) => {
        await deltaBatcher.flush();
        const requestId = this.createId();
        await publisher.publish({
          type: "capability.started",
          requestId,
          capability: descriptor.id,
        });
        const request: CapabilityRequestV1 = {
          version: 1,
          kind: "capability.request",
          requestId,
          runId: task.runId,
          conversationId: task.conversationId,
          actorSubjectId: task.actorSubjectId,
          agentSubjectId: task.agentSubjectId,
          traceId: task.traceId,
          capability: descriptor.id,
          input: input as CapabilityRequestV1["input"],
          requestedAt: new Date(this.now()).toISOString(),
          deadlineAt: deadline.effectiveDeadlineAt,
        };

        const result = await this.requestCapability(request, descriptor.id, publisher, deadline);
        if (result.status === "failed") throw new CapabilityBridgeError();
        await publisher.publish({
          type: "capability.completed",
          requestId,
          capability: descriptor.id,
          ...capabilityCompletionMetrics(descriptor.id, result.output),
        });
        return result.output;
      },
    });
  }

  /** Pre-2A snapshot compat: the users.search vertical with its typed contract. */
  private buildLegacyUsersSearchTool(
    task: AgentRunTaskV1,
    publisher: RunEventPublisher,
    deadline: DeadlineContext,
    deltaBatcher: DeltaBatcher,
  ) {
    return tool({
      description: "Search and paginate users that both the current user and Agent are authorized to read.",
      inputSchema: UsersSearchInputV1Schema,
      execute: async (input) => {
        await deltaBatcher.flush();
        const requestId = this.createId();
        await publisher.publish({
          type: "capability.started",
          requestId,
          capability: "users.search",
        });
        const request: CapabilityRequestV1 = {
          version: 1,
          kind: "capability.request",
          requestId,
          runId: task.runId,
          conversationId: task.conversationId,
          actorSubjectId: task.actorSubjectId,
          agentSubjectId: task.agentSubjectId,
          traceId: task.traceId,
          capability: "users.search",
          input,
          requestedAt: new Date(this.now()).toISOString(),
          deadlineAt: deadline.effectiveDeadlineAt,
        };

        const result = await this.requestCapability(request, "users.search", publisher, deadline);
        if (result.status === "failed") throw new CapabilityBridgeError();
        // The contract union admits generic JSON; the vertical keeps its typed
        // output, so re-validate before the typed field access below.
        const output = UsersSearchOutputV1Schema.parse(result.output);
        await publisher.publish({
          type: "capability.completed",
          requestId,
          capability: "users.search",
          resultCount: output.items.length,
          total: output.total,
        });
        return output;
      },
    });
  }

  private async requestCapability(
    request: CapabilityRequestV1,
    capabilityId: string,
    publisher: RunEventPublisher,
    deadline: DeadlineContext,
  ): Promise<CapabilityResultV1> {
    try {
      return CapabilityResultV1Schema.parse(
        await this.options.capabilities.execute(request, deadline.signal),
      );
    } catch {
      await publisher.publish({
        type: "capability.failed",
        requestId: request.requestId,
        capability: capabilityId,
        errorCode: "capability_failed",
      });
      throw new CapabilityBridgeError();
    }
  }
}

/**
 * Result metrics for a `capability.completed` event. The vertical users.search
 * reports its pagination counts; a generic (MCP) output has no agreed shape, so
 * a list reports its length and any other value counts as the one result the
 * call produced — never 0, which would read as "the tool found nothing".
 */
function capabilityCompletionMetrics(
  capabilityId: string,
  output: unknown,
): { resultCount: number; total: number } {
  if (
    capabilityId === "users.search" &&
    output &&
    typeof output === "object" &&
    !Array.isArray(output) &&
    "items" in output &&
    "total" in output
  ) {
    const items = (output as { items: unknown }).items;
    const total = (output as { total: unknown }).total;
    return {
      resultCount: Array.isArray(items) ? items.length : 0,
      total: typeof total === "number" ? total : 0,
    };
  }
  const count = Array.isArray(output) ? output.length : 1;
  return { resultCount: count, total: count };
}
