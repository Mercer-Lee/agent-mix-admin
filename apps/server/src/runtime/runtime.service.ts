import { randomUUID } from "node:crypto";
import {
  AGENT_CAPABILITY_REQUESTS_QUEUE,
  AGENT_RUN_CANCEL_OUTBOX_TOPIC,
  AGENT_RUN_CANCELLED_KEY_PREFIX,
  AGENT_RUN_CONTROL_CHANNEL,
  AGENT_RUN_EVENTS_QUEUE,
  AGENT_RUN_TASKS_QUEUE,
  AgentRunControlV1Schema,
  AgentRunEventV1Schema,
  AgentRunTaskV1Schema,
  CapabilityRequestV1Schema,
  CapabilityResultV1Schema,
  RuntimeEventV1Schema,
  RuntimeOutboxMessageV1Schema,
  type AgentRunEventV1,
  type AgentRunControlV1,
  type AgentRunTaskV1,
  type CapabilityRequestV1,
  type CapabilityResultV1,
  type ModelCheckEventV1,
  type RuntimeEventV1,
  type RuntimeTaskV1,
} from "@agentmix/core";
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Job, Queue, Worker } from "bullmq";
import { and, eq, inArray, lte, max, sql } from "drizzle-orm";
import IORedis from "ioredis";
import { AuditService } from "../audit/audit.service";
import { CapabilityExecutor } from "../capabilities/capability.executor";
import type { Environment } from "../config/environment";
import { DatabaseService } from "../database/database.service";
import {
  agentRunEvents,
  agentRuns,
  conversationMessages,
  modelChecks,
  outboxEvents,
} from "../database/schema";

const OUTBOX_POLL_MS = 250;
const OUTBOX_BATCH_SIZE = 25;
const CANCELLATION_TTL_SECONDS = 180;
const RUNTIME_WATCHDOG_POLL_MS = 5_000;
const RUN_WATCHDOG_TIMEOUT_MS = 150_000;
const MODEL_CHECK_WATCHDOG_TIMEOUT_MS = 60_000;
const WATCHDOG_BATCH_SIZE = 25;

type RuntimeHealth = {
  redis: { status: "ok" | "down" };
  worker: { status: "ok" | "warn" | "unknown"; count: number | null };
};

type CapabilityFailureCode = Extract<CapabilityResultV1, { status: "failed" }>["errorCode"];

type CapabilityRunState = {
  status: ProjectableRunStatus;
  conversationId: string;
  actorSubjectId: string;
  agentSubjectId: string;
  cancelRequestedAt: Date | null;
  executionSnapshot: Record<string, unknown>;
};

export interface AgentRunCancellationDelivery {
  setMarker(runId: string): Promise<void>;
  publish(control: AgentRunControlV1): Promise<void>;
  removeQueuedTask(runId: string): Promise<void>;
}

type ProjectableRunStatus = "queued" | "running" | "completed" | "failed" | "canceled";

interface RunProjectionState {
  status: ProjectableRunStatus;
  attempt: number;
  conversationId: string;
}

/**
 * Decide whether an event may enter the durable/SSE-visible event stream.
 * The caller holds the agent_runs row lock, so this also serializes multiple
 * control-plane replicas without requiring a new schema constraint.
 */
export type AgentRunEventProjectionDecision = "persist" | "discard" | "retry";

export async function executeWithSafeQueueError<Result>(
  safeMessage: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch {
    // BullMQ persists thrown messages/stacks as failedReason/stacktrace. Never
    // attach the database/provider error as a cause because it can contain SQL
    // params, conversation content, prompts, headers, or credentials.
    throw new Error(safeMessage);
  }
}

export function runSafelyInBackground(
  logger: { error(message: string): void },
  safeMessage: string,
  operation: () => Promise<unknown>,
): void {
  void operation().catch(() => {
    // Background work is outside the HTTP exception filter. Never log the
    // rejected value because database errors can embed SQL parameters.
    logger.error(safeMessage);
  });
}

export function createRuntimeTaskProducerConnectionOptions(redisUrl: string) {
  return {
    url: redisUrl,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  } as const;
}

export function decideAgentRunEventProjection(
  run: RunProjectionState,
  event: AgentRunEventV1,
  highestSequenceForAttempt: number | null,
): AgentRunEventProjectionDecision {
  if (!["queued", "running"].includes(run.status)) return "discard";
  if (event.conversationId !== run.conversationId) return "discard";
  if (event.attempt < run.attempt) return "discard";
  if (highestSequenceForAttempt !== null && event.sequence <= highestSequenceForAttempt) {
    return "discard";
  }

  const expectedSequence = (highestSequenceForAttempt ?? 0) + 1;
  if (event.sequence > expectedSequence) return "retry";

  if (event.type === "run.reset") {
    return event.attempt > run.attempt ? "persist" : "discard";
  }

  if (event.attempt > run.attempt) {
    const startsInitialAttempt =
      run.attempt === 0 && event.attempt === 1 && event.type === "run.started";
    return startsInitialAttempt ? "persist" : "retry";
  }

  return run.attempt >= 1 ? "persist" : "retry";
}

function cancellationEventFrom(event: AgentRunEventV1): AgentRunEventV1 {
  return AgentRunEventV1Schema.parse({
    version: 1,
    kind: "agent.run.event",
    eventId: event.eventId,
    runId: event.runId,
    conversationId: event.conversationId,
    attempt: event.attempt,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    type: "run.cancelled",
    reason: "requested",
  });
}

function safeCapabilityErrorCode(error: unknown): CapabilityFailureCode {
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (
      [
        "CAPABILITY_NOT_FOUND",
        "CAPABILITY_FORBIDDEN",
        "CAPABILITY_INPUT_INVALID",
        "CAPABILITY_OUTPUT_INVALID",
        "CAPABILITY_EXECUTION_FAILED",
      ].includes(code)
    ) {
      return code as CapabilityFailureCode;
    }
  }
  return "CAPABILITY_INTERNAL";
}

export async function deliverAgentRunCancellation(
  control: AgentRunControlV1,
  delivery: AgentRunCancellationDelivery,
): Promise<void> {
  // Keep these operations sequential so any partial delivery rejects and the
  // persistent outbox retries all three idempotent steps.
  await delivery.setMarker(control.runId);
  await delivery.publish(control);
  await delivery.removeQueuedTask(control.runId);
}

export function capabilityRequestFailureCode(
  run: CapabilityRunState | undefined,
  request: CapabilityRequestV1,
  now = Date.now(),
): CapabilityFailureCode | null {
  if (
    !run ||
    !["queued", "running"].includes(run.status) ||
    run.cancelRequestedAt ||
    run.conversationId !== request.conversationId ||
    run.actorSubjectId !== request.actorSubjectId ||
    run.agentSubjectId !== request.agentSubjectId
  ) {
    return "CAPABILITY_CANCELLED";
  }

  const requestDeadline = Date.parse(request.deadlineAt);
  if (requestDeadline <= now) return "CAPABILITY_TIMEOUT";

  const snapshotResult = AgentRunTaskV1Schema.safeParse(run.executionSnapshot);
  if (!snapshotResult.success) return "CAPABILITY_FORBIDDEN";
  const snapshot = snapshotResult.data;
  const requestStartedAt = Date.parse(request.requestedAt);
  const snapshotCreatedAt = Date.parse(snapshot.createdAt);
  const snapshotDeadline = Date.parse(snapshot.deadlineAt);
  if (
    requestStartedAt < snapshotCreatedAt ||
    requestStartedAt > requestDeadline ||
    requestDeadline > snapshotDeadline ||
    request.runId !== snapshot.runId ||
    request.conversationId !== snapshot.conversationId ||
    request.actorSubjectId !== snapshot.actorSubjectId ||
    request.agentSubjectId !== snapshot.agentSubjectId ||
    request.traceId !== snapshot.traceId ||
    !snapshot.capabilities.includes(request.capability)
  ) {
    return "CAPABILITY_FORBIDDEN";
  }
  return null;
}

function normalizeUsageForDatabase(usage: {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}) {
  return {
    inputTokens: usage.inputTokens ?? undefined,
    outputTokens: usage.outputTokens ?? undefined,
    totalTokens: usage.totalTokens ?? undefined,
  };
}

@Injectable()
export class RuntimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(RuntimeService.name);
  private readonly redisUrl: string;
  private readonly workerConnectionOptions: { url: string; maxRetriesPerRequest: null };
  private readonly controlRedis: IORedis;
  private readonly taskQueue: Queue<RuntimeTaskV1>;
  private readonly eventWorker: Worker<RuntimeEventV1>;
  private readonly capabilityWorker: Worker;
  private outboxTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private dispatching = false;
  private reconcilingStaleTasks = false;

  constructor(
    config: ConfigService<Environment, true>,
    private readonly database: DatabaseService,
    private readonly capabilities: CapabilityExecutor,
    private readonly audit: AuditService,
  ) {
    this.redisUrl = config.get("REDIS_URL", { infer: true });
    this.workerConnectionOptions = { url: this.redisUrl, maxRetriesPerRequest: null };
    this.controlRedis = new IORedis(this.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
    });
    this.controlRedis.on("error", () => undefined);
    this.taskQueue = new Queue<RuntimeTaskV1>(AGENT_RUN_TASKS_QUEUE, {
      // This producer runs while an agent_runs row lock is held. It must reject
      // promptly during Redis outages so the transaction rolls back and queued
      // cancellation is never blocked behind an unbounded offline command.
      connection: createRuntimeTaskProducerConnectionOptions(this.redisUrl),
    });
    this.taskQueue.on("error", () => undefined);
    this.eventWorker = new Worker<RuntimeEventV1>(
      AGENT_RUN_EVENTS_QUEUE,
      (job) =>
        executeWithSafeQueueError("Runtime event processing failed", () =>
          this.consumeRuntimeEvent(job),
        ),
      { connection: this.workerConnectionOptions, concurrency: 1 },
    );
    this.eventWorker.on("error", () => undefined);
    this.capabilityWorker = new Worker(
      AGENT_CAPABILITY_REQUESTS_QUEUE,
      (job) =>
        executeWithSafeQueueError("Capability request processing failed", () =>
          this.executeCapability(job),
        ),
      { connection: this.workerConnectionOptions, concurrency: 10 },
    );
    this.capabilityWorker.on("error", () => undefined);
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.controlRedis.connect();
    } catch {
      // Redis health is reported by /health; startup remains available for governance reads.
    }
    this.outboxTimer = setInterval(
      () =>
        runSafelyInBackground(
          this.logger,
          "Runtime outbox dispatch failed",
          () => this.dispatchOutboxOnce(),
        ),
      OUTBOX_POLL_MS,
    );
    this.outboxTimer.unref();
    this.watchdogTimer = setInterval(
      () =>
        runSafelyInBackground(
          this.logger,
          "Runtime watchdog reconciliation failed",
          () => this.reconcileStaleRuntimeTasks(),
        ),
      RUNTIME_WATCHDOG_POLL_MS,
    );
    this.watchdogTimer.unref();
    runSafelyInBackground(this.logger, "Initial runtime outbox dispatch failed", () =>
      this.dispatchOutboxOnce(),
    );
    runSafelyInBackground(this.logger, "Initial runtime watchdog reconciliation failed", () =>
      this.reconcileStaleRuntimeTasks(),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    await Promise.allSettled([
      this.eventWorker.close(),
      this.capabilityWorker.close(),
      this.taskQueue.close(),
    ]);
    this.controlRedis.disconnect();
  }

  async dispatchOutboxOnce(runId?: string): Promise<number> {
    if (this.dispatching) return 0;
    this.dispatching = true;
    let published = 0;
    try {
      const rows = await this.database.db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.status, "pending"),
            lte(outboxEvents.availableAt, new Date()),
            runId ? eq(outboxEvents.runId, runId) : undefined,
          ),
        )
        .orderBy(
          sql`case when ${outboxEvents.topic} = ${AGENT_RUN_CANCEL_OUTBOX_TOPIC} then 0 else 1 end`,
          outboxEvents.createdAt,
        )
        .limit(OUTBOX_BATCH_SIZE);
      // SQL priority is intentionally applied before LIMIT so cancellation
      // recovery overtakes task backlogs larger than one dispatcher batch.
      for (const row of rows) {
        const parsed = RuntimeOutboxMessageV1Schema.safeParse(row.payload);
        const topicMatches =
          parsed.success &&
          ((parsed.data.kind === "agent.run.cancel" &&
            row.topic === AGENT_RUN_CANCEL_OUTBOX_TOPIC) ||
            (parsed.data.kind === "agent.run" && row.topic === "agent.run.requested") ||
            (parsed.data.kind === "model.check" && row.topic === "model.check.requested"));
        if (!parsed.success || !topicMatches) {
          const handledAt = new Date();
          const updated = await this.database.db
            .update(outboxEvents)
            .set({
              status: "published",
              attempts: row.attempts + 1,
              publishedAt: handledAt,
              lastErrorCode: parsed.success ? "INVALID_OUTBOX_TOPIC" : "INVALID_OUTBOX_PAYLOAD",
              updatedAt: handledAt,
            })
            .where(and(eq(outboxEvents.id, row.id), eq(outboxEvents.status, "pending")))
            .returning({ id: outboxEvents.id });
          if (updated.length) published += 1;
          continue;
        }
        const message = parsed.data;
        try {
          if (message.kind === "agent.run.cancel") {
            await this.deliverCancellationControl(message);
          } else if (message.kind === "agent.run") {
            if (await this.enqueueAgentRunIfDispatchable(row.id, message)) published += 1;
            continue;
          } else {
            await this.taskQueue.add(message.kind, message, {
              jobId: message.checkId,
              attempts: 1,
              removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
              removeOnFail: { age: 7 * 24 * 60 * 60, count: 10_000 },
            });
          }
          const updated = await this.database.db
            .update(outboxEvents)
            .set({ status: "published", publishedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(outboxEvents.id, row.id), eq(outboxEvents.status, "pending")))
            .returning({ id: outboxEvents.id });
          if (updated.length) published += 1;
        } catch {
          const attempts = row.attempts + 1;
          const delay = Math.min(60_000, 500 * 2 ** Math.min(attempts, 7));
          await this.database.db
            .update(outboxEvents)
            .set({
              attempts,
              availableAt: new Date(Date.now() + delay),
              lastErrorCode:
                message.kind === "agent.run.cancel"
                  ? "CONTROL_DELIVERY_UNAVAILABLE"
                  : "QUEUE_UNAVAILABLE",
              updatedAt: new Date(),
            })
            .where(and(eq(outboxEvents.id, row.id), eq(outboxEvents.status, "pending")));
        }
      }
    } finally {
      this.dispatching = false;
    }
    return published;
  }

  /**
   * Linearize queued-run dispatch against cancellation on the agent_runs row.
   * If cancellation commits first, its transaction changes the run/outbox while
   * holding this same lock and the task is never enqueued. If dispatch wins,
   * queue insertion happens before cancellation can commit, after which the
   * cancellation marker/control path aborts or removes the already-dispatched
   * job. Keeping the Redis add inside the transaction is intentional: a crash
   * before commit leaves the outbox pending, and BullMQ's stable jobId makes the
   * retry idempotent.
   */
  private async enqueueAgentRunIfDispatchable(
    outboxEventId: string,
    task: AgentRunTaskV1,
  ): Promise<boolean> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from agent_runs where id = ${task.runId} for update`);
      const currentRows = await tx
        .select({
          runStatus: agentRuns.status,
          cancelRequestedAt: agentRuns.cancelRequestedAt,
        })
        .from(outboxEvents)
        .innerJoin(agentRuns, eq(outboxEvents.runId, agentRuns.id))
        .where(
          and(
            eq(outboxEvents.id, outboxEventId),
            eq(outboxEvents.runId, task.runId),
            eq(outboxEvents.topic, "agent.run.requested"),
            eq(outboxEvents.status, "pending"),
          ),
        )
        .limit(1);
      const current = currentRows[0];
      if (!current) return false;

      if (current.runStatus !== "queued" || current.cancelRequestedAt) {
        const handledAt = new Date();
        const updated = await tx
          .update(outboxEvents)
          .set({
            status: "published",
            publishedAt: handledAt,
            lastErrorCode:
              current.runStatus === "canceled" || current.cancelRequestedAt
                ? "CANCELED"
                : "RUN_NOT_DISPATCHABLE",
            updatedAt: handledAt,
          })
          .where(and(eq(outboxEvents.id, outboxEventId), eq(outboxEvents.status, "pending")))
          .returning({ id: outboxEvents.id });
        return updated.length > 0;
      }

      await this.taskQueue.add(task.kind, task, {
        jobId: task.runId,
        attempts: 1,
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 10_000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 10_000 },
      });
      const publishedAt = new Date();
      const updated = await tx
        .update(outboxEvents)
        .set({ status: "published", publishedAt, updatedAt: publishedAt })
        .where(and(eq(outboxEvents.id, outboxEventId), eq(outboxEvents.status, "pending")))
        .returning({ id: outboxEvents.id });
      return updated.length > 0;
    });
  }

  /**
   * Reconcile jobs whose BullMQ execution or event delivery never produced a
   * terminal database event. Pending outbox rows are deliberately excluded so
   * a Redis outage can still recover through the normal dispatcher.
   */
  async reconcileStaleRuntimeTasks(referenceTime = new Date()): Promise<{
    runs: number;
    modelChecks: number;
  }> {
    if (this.reconcilingStaleTasks) return { runs: 0, modelChecks: 0 };
    this.reconcilingStaleTasks = true;
    try {
      const runCutoff = new Date(referenceTime.getTime() - RUN_WATCHDOG_TIMEOUT_MS);
      const checkCutoff = new Date(referenceTime.getTime() - MODEL_CHECK_WATCHDOG_TIMEOUT_MS);
      const [staleRuns, staleChecks] = await Promise.all([
        this.database.db
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .innerJoin(outboxEvents, eq(outboxEvents.runId, agentRuns.id))
          .where(
            and(
              inArray(agentRuns.status, ["queued", "running"]),
              eq(outboxEvents.topic, "agent.run.requested"),
              eq(outboxEvents.status, "published"),
              lte(agentRuns.createdAt, runCutoff),
            ),
          )
          .limit(WATCHDOG_BATCH_SIZE),
        this.database.db
          .select({ id: modelChecks.id })
          .from(modelChecks)
          .innerJoin(outboxEvents, eq(outboxEvents.modelCheckId, modelChecks.id))
          .where(
            and(
              inArray(modelChecks.status, ["queued", "running"]),
              eq(outboxEvents.status, "published"),
              lte(modelChecks.createdAt, checkCutoff),
            ),
          )
          .limit(WATCHDOG_BATCH_SIZE),
      ]);

      let runs = 0;
      for (const candidate of staleRuns) {
        const terminal = await this.failStaleRun(candidate.id, runCutoff, referenceTime);
        if (!terminal) continue;
        runs += 1;
        await this.cancelRun(candidate.id);
      }

      let checks = 0;
      for (const candidate of staleChecks) {
        if (await this.failStaleModelCheck(candidate.id, checkCutoff, referenceTime)) {
          checks += 1;
          await this.removeQueuedTask(candidate.id).catch(() => undefined);
        }
      }
      return { runs, modelChecks: checks };
    } finally {
      this.reconcilingStaleTasks = false;
    }
  }

  private async failStaleRun(runId: string, cutoff: Date, completedAt: Date) {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from agent_runs where id = ${runId} for update`);
      const rows = await tx
        .select({
          status: agentRuns.status,
          attempt: agentRuns.attempt,
          conversationId: agentRuns.conversationId,
          actorSubjectId: agentRuns.requestedBySubjectId,
          modelProfileId: agentRuns.modelProfileId,
          createdAt: agentRuns.createdAt,
          cancelRequestedAt: agentRuns.cancelRequestedAt,
        })
        .from(agentRuns)
        .innerJoin(outboxEvents, eq(outboxEvents.runId, agentRuns.id))
        .where(
          and(
            eq(agentRuns.id, runId),
            inArray(agentRuns.status, ["queued", "running"]),
            eq(outboxEvents.topic, "agent.run.requested"),
            eq(outboxEvents.status, "published"),
            lte(agentRuns.createdAt, cutoff),
          ),
        )
        .limit(1);
      const run = rows[0];
      if (!run) return null;

      const attempt = Math.max(1, run.attempt);
      const sequenceRows = await tx
        .select({ value: max(agentRunEvents.sequence) })
        .from(agentRunEvents)
        .where(and(eq(agentRunEvents.runId, runId), eq(agentRunEvents.attempt, attempt)));
      const canceled = run.cancelRequestedAt !== null;
      const event = AgentRunEventV1Schema.parse({
        version: 1,
        kind: "agent.run.event",
        eventId: randomUUID(),
        runId,
        conversationId: run.conversationId,
        attempt,
        sequence: (sequenceRows[0]?.value ?? 0) + 1,
        occurredAt: completedAt.toISOString(),
        ...(canceled
          ? { type: "run.cancelled", reason: "requested" }
          : { type: "run.failed", errorCode: "deadline_exceeded", retryable: false }),
      });
      const updated = await tx
        .update(agentRuns)
        .set({
          status: canceled ? "canceled" : "failed",
          attempt,
          errorCode: canceled ? "cancelled" : "deadline_exceeded",
          errorMessage: canceled ? "Generation stopped" : "Generation deadline exceeded",
          completedAt,
          updatedAt: completedAt,
        })
        .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, ["queued", "running"])))
        .returning({ id: agentRuns.id });
      if (!updated.length) return null;
      await tx.insert(agentRunEvents).values({
        eventId: event.eventId,
        runId,
        sequence: event.sequence,
        attempt: event.attempt,
        type: event.type,
        payload: event as unknown as Record<string, unknown>,
        occurredAt: completedAt,
      });
      const control = AgentRunControlV1Schema.parse({
        version: 1,
        kind: "agent.run.cancel",
        runId,
        requestedAt: completedAt.toISOString(),
      });
      await tx
        .insert(outboxEvents)
        .values({
          runId,
          topic: AGENT_RUN_CANCEL_OUTBOX_TOPIC,
          deduplicationKey: `agent.run.cancel:${runId}`,
          payload: control as unknown as Record<string, unknown>,
        })
        .onConflictDoNothing({ target: outboxEvents.deduplicationKey });
      await this.audit.record(
        {
          actorSubjectId: run.actorSubjectId,
          action: "conversation.run.finished",
          resourceType: "conversation_run",
          resourceId: runId,
          outcome: "failure",
          metadata: {
            status: canceled ? "canceled" : "failed",
            modelProfileId: run.modelProfileId,
            errorCode: canceled ? "cancelled" : "deadline_exceeded",
            durationMs: Math.max(0, completedAt.getTime() - run.createdAt.getTime()),
          },
        },
        tx,
      );
      return { canceled };
    });
  }

  private async failStaleModelCheck(checkId: string, cutoff: Date, completedAt: Date) {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from model_checks where id = ${checkId} for update`);
      const rows = await tx
        .select({ id: modelChecks.id })
        .from(modelChecks)
        .innerJoin(outboxEvents, eq(outboxEvents.modelCheckId, modelChecks.id))
        .where(
          and(
            eq(modelChecks.id, checkId),
            inArray(modelChecks.status, ["queued", "running"]),
            eq(outboxEvents.status, "published"),
            lte(modelChecks.createdAt, cutoff),
          ),
        )
        .limit(1);
      if (!rows.length) return false;
      const updated = await tx
        .update(modelChecks)
        .set({
          status: "failed",
          latencyMs: null,
          usage: null,
          errorCode: "deadline_exceeded",
          errorMessage: "Model connection check timed out",
          completedAt,
          updatedAt: completedAt,
        })
        .where(and(eq(modelChecks.id, checkId), inArray(modelChecks.status, ["queued", "running"])))
        .returning({ id: modelChecks.id });
      return updated.length > 0;
    });
  }

  private async removeQueuedTask(jobId: string): Promise<void> {
    const job = await this.taskQueue.getJob(jobId);
    if (!job) return;
    const state = await job.getState();
    if (["waiting", "delayed", "prioritized", "paused"].includes(state)) {
      await job.remove();
    }
  }

  async cancelRun(runId: string): Promise<void> {
    try {
      // The cancellation command is already durable in PostgreSQL. This call
      // only accelerates delivery; the background dispatcher retains retries.
      // It deliberately bypasses the batch dispatcher mutex: a batch may be
      // holding the run lock while it finishes queue insertion, and the cancel
      // control must be delivered immediately after the cancel transaction wins.
      await this.dispatchCancellationOutboxOnce(runId);
    } catch {
      // The pending outbox row remains authoritative if Redis is unavailable.
    }
  }

  private async dispatchCancellationOutboxOnce(runId: string): Promise<number> {
    const rows = await this.database.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.runId, runId),
          eq(outboxEvents.topic, AGENT_RUN_CANCEL_OUTBOX_TOPIC),
          eq(outboxEvents.status, "pending"),
          lte(outboxEvents.availableAt, new Date()),
        ),
      )
      .orderBy(outboxEvents.createdAt)
      .limit(1);
    const row = rows[0];
    if (!row) return 0;

    const parsed = AgentRunControlV1Schema.safeParse(row.payload);
    if (!parsed.success || parsed.data.runId !== runId) {
      const handledAt = new Date();
      const updated = await this.database.db
        .update(outboxEvents)
        .set({
          status: "published",
          attempts: row.attempts + 1,
          publishedAt: handledAt,
          lastErrorCode: "INVALID_OUTBOX_PAYLOAD",
          updatedAt: handledAt,
        })
        .where(and(eq(outboxEvents.id, row.id), eq(outboxEvents.status, "pending")))
        .returning({ id: outboxEvents.id });
      return updated.length;
    }

    try {
      await this.deliverCancellationControl(parsed.data);
      const publishedAt = new Date();
      const updated = await this.database.db
        .update(outboxEvents)
        .set({ status: "published", publishedAt, updatedAt: publishedAt })
        .where(and(eq(outboxEvents.id, row.id), eq(outboxEvents.status, "pending")))
        .returning({ id: outboxEvents.id });
      return updated.length;
    } catch {
      const attempts = row.attempts + 1;
      const delay = Math.min(60_000, 500 * 2 ** Math.min(attempts, 7));
      await this.database.db
        .update(outboxEvents)
        .set({
          attempts,
          availableAt: new Date(Date.now() + delay),
          lastErrorCode: "CONTROL_DELIVERY_UNAVAILABLE",
          updatedAt: new Date(),
        })
        .where(and(eq(outboxEvents.id, row.id), eq(outboxEvents.status, "pending")));
      return 0;
    }
  }

  private async deliverCancellationControl(control: AgentRunControlV1): Promise<void> {
    await this.ensureControlRedis();
    await deliverAgentRunCancellation(control, {
      setMarker: async (runId) => {
        await this.controlRedis.set(
          `${AGENT_RUN_CANCELLED_KEY_PREFIX}${runId}`,
          "1",
          "EX",
          CANCELLATION_TTL_SECONDS,
        );
      },
      publish: async (message) => {
        await this.controlRedis.publish(AGENT_RUN_CONTROL_CHANNEL, JSON.stringify(message));
      },
      removeQueuedTask: (runId) => this.removeQueuedTask(runId),
    });
  }

  async getHealth(): Promise<RuntimeHealth> {
    try {
      await this.ensureControlRedis();
      await this.controlRedis.ping();
    } catch {
      return { redis: { status: "down" }, worker: { status: "unknown", count: null } };
    }
    try {
      const workers = await this.taskQueue.getWorkers();
      return {
        redis: { status: "ok" },
        worker: workers.length
          ? { status: "ok", count: workers.length }
          : { status: "warn", count: 0 },
      };
    } catch {
      return { redis: { status: "ok" }, worker: { status: "unknown", count: null } };
    }
  }

  private async ensureControlRedis(): Promise<void> {
    if (this.controlRedis.status === "wait" || this.controlRedis.status === "end") {
      await this.controlRedis.connect();
    }
  }

  private async executeCapability(job: Job): Promise<CapabilityResultV1> {
    const request = CapabilityRequestV1Schema.parse(job.data);
    const completedAt = () => new Date().toISOString();
    const runRows = await this.database.db
      .select({
        status: agentRuns.status,
        conversationId: agentRuns.conversationId,
        actorSubjectId: agentRuns.requestedBySubjectId,
        agentSubjectId: agentRuns.agentSubjectId,
        cancelRequestedAt: agentRuns.cancelRequestedAt,
        executionSnapshot: agentRuns.executionSnapshot,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, request.runId))
      .limit(1);
    const run = runRows[0];
    const authorizationFailure = capabilityRequestFailureCode(run, request);
    if (authorizationFailure) {
      return CapabilityResultV1Schema.parse({
        version: 1,
        kind: "capability.result",
        requestId: request.requestId,
        status: "failed",
        errorCode: authorizationFailure,
        completedAt: completedAt(),
      });
    }
    try {
      // The CapabilityExecutor has already validated input and output against
      // the capability's registered schemas; the RPC boundary only enforces
      // JSON shape so MCP tools with dynamic schemas flow through unchanged.
      const output = await this.capabilities.execute(
        request.capability,
        request.input,
        {
          actorSubjectId: request.actorSubjectId,
          agentSubjectId: request.agentSubjectId,
          traceId: request.traceId,
          conversationId: request.conversationId,
        },
      );
      return CapabilityResultV1Schema.parse({
        version: 1,
        kind: "capability.result",
        requestId: request.requestId,
        status: "completed",
        output,
        completedAt: completedAt(),
      });
    } catch (error) {
      return CapabilityResultV1Schema.parse({
        version: 1,
        kind: "capability.result",
        requestId: request.requestId,
        status: "failed",
        errorCode: safeCapabilityErrorCode(error),
        completedAt: completedAt(),
      });
    }
  }

  private async consumeRuntimeEvent(job: Job<RuntimeEventV1>): Promise<void> {
    const event = RuntimeEventV1Schema.parse(job.data);
    if (event.kind === "model.check.event") {
      await this.consumeModelCheckEvent(event);
      return;
    }
    await this.consumeAgentRunEvent(event);
  }

  private async consumeModelCheckEvent(event: ModelCheckEventV1): Promise<void> {
    const now = new Date();
    if (event.type === "model.check.started") {
      await this.database.db
        .update(modelChecks)
        .set({ status: "running", startedAt: new Date(event.occurredAt), updatedAt: now })
        .where(and(eq(modelChecks.id, event.checkId), eq(modelChecks.status, "queued")));
      return;
    }
    const status = event.type === "model.check.completed" ? "succeeded" : "failed";
    await this.database.db
      .update(modelChecks)
      .set({
        status,
        latencyMs: event.latencyMs,
        usage: event.usage ? normalizeUsageForDatabase(event.usage) : null,
        errorCode: event.type === "model.check.failed" ? event.errorCode : null,
        errorMessage: event.type === "model.check.failed" ? "Model connection check failed" : null,
        completedAt: new Date(event.occurredAt),
        updatedAt: now,
      })
      .where(and(eq(modelChecks.id, event.checkId), inArray(modelChecks.status, ["queued", "running"])));
  }

  private async consumeAgentRunEvent(event: AgentRunEventV1): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from agent_runs where id = ${event.runId} for update`);
      const runRows = await tx
        .select({
          id: agentRuns.id,
          status: agentRuns.status,
          attempt: agentRuns.attempt,
          conversationId: agentRuns.conversationId,
          actorSubjectId: agentRuns.requestedBySubjectId,
          modelProfileId: agentRuns.modelProfileId,
          createdAt: agentRuns.createdAt,
          cancelRequestedAt: agentRuns.cancelRequestedAt,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, event.runId))
        .limit(1);
      const run = runRows[0];
      if (!run) return;

      const projectedEvent =
        run.cancelRequestedAt && !["run.cancelled", "run.reset"].includes(event.type)
          ? cancellationEventFrom(event)
          : event;

      const sequenceRows = await tx
        .select({ value: max(agentRunEvents.sequence) })
        .from(agentRunEvents)
        .where(
          and(
            eq(agentRunEvents.runId, event.runId),
            eq(agentRunEvents.attempt, projectedEvent.attempt),
          ),
        );
      const decision = decideAgentRunEventProjection(
        run,
        projectedEvent,
        sequenceRows[0]?.value ?? null,
      );
      if (decision === "discard") return;
      if (decision === "retry") {
        throw new Error("Runtime event is waiting for an earlier event");
      }

      const inserted = await tx
        .insert(agentRunEvents)
        .values({
          eventId: projectedEvent.eventId,
          runId: projectedEvent.runId,
          sequence: projectedEvent.sequence,
          attempt: projectedEvent.attempt,
          type: projectedEvent.type,
          payload: projectedEvent as unknown as Record<string, unknown>,
          occurredAt: new Date(projectedEvent.occurredAt),
        })
        .onConflictDoNothing({ target: agentRunEvents.eventId })
        .returning({ id: agentRunEvents.id });
      if (!inserted.length) return;

      if (projectedEvent.type === "run.started") {
        await tx
          .update(agentRuns)
          .set({
            status: "running",
            attempt: projectedEvent.attempt,
            startedAt: new Date(projectedEvent.occurredAt),
            updatedAt: new Date(),
          })
          .where(eq(agentRuns.id, event.runId));
        return;
      }
      if (projectedEvent.type === "run.reset") {
        await tx
          .update(agentRuns)
          .set({ attempt: projectedEvent.attempt, updatedAt: new Date() })
          .where(eq(agentRuns.id, event.runId));
        return;
      }

      if (projectedEvent.type === "run.completed") {
        const assistant = await tx
          .insert(conversationMessages)
          .values({
            conversationId: projectedEvent.conversationId,
            role: "assistant",
            content: projectedEvent.text,
          })
          .returning({ id: conversationMessages.id });
        const completedAt = new Date(projectedEvent.occurredAt);
        await tx
          .update(agentRuns)
          .set({
            status: "completed",
            attempt: projectedEvent.attempt,
            assistantMessageId: assistant[0]!.id,
            usage: normalizeUsageForDatabase(projectedEvent.usage),
            finishReason: projectedEvent.finishReason,
            errorCode: null,
            errorMessage: null,
            completedAt,
            updatedAt: completedAt,
          })
          .where(eq(agentRuns.id, event.runId));
        await this.audit.record(
          {
            actorSubjectId: run.actorSubjectId,
            action: "conversation.run.finished",
            resourceType: "conversation_run",
            resourceId: projectedEvent.runId,
            outcome: "success",
            metadata: {
              status: "completed",
              modelProfileId: run.modelProfileId,
              usage: projectedEvent.usage,
              finishReason: projectedEvent.finishReason,
              durationMs: completedAt.getTime() - run.createdAt.getTime(),
            },
          },
          tx,
        );
        return;
      }
      if (projectedEvent.type === "run.failed" || projectedEvent.type === "run.cancelled") {
        const completedAt = new Date(projectedEvent.occurredAt);
        const canceled = projectedEvent.type === "run.cancelled";
        const errorCode = canceled ? "cancelled" : projectedEvent.errorCode;
        await tx
          .update(agentRuns)
          .set({
            status: canceled ? "canceled" : "failed",
            attempt: projectedEvent.attempt,
            errorCode,
            errorMessage: canceled ? "Generation stopped" : "Generation failed",
            completedAt,
            updatedAt: completedAt,
          })
          .where(eq(agentRuns.id, event.runId));
        await this.audit.record(
          {
            actorSubjectId: run.actorSubjectId,
            action: "conversation.run.finished",
            resourceType: "conversation_run",
            resourceId: projectedEvent.runId,
            outcome: "failure",
            metadata: {
              status: canceled ? "canceled" : "failed",
              modelProfileId: run.modelProfileId,
              errorCode,
              durationMs: completedAt.getTime() - run.createdAt.getTime(),
            },
          },
          tx,
        );
      }
    });
  }
}
