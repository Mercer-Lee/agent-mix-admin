import { randomUUID } from "node:crypto";
import {
  AGENT_CAPABILITY_REQUESTS_QUEUE,
  AGENT_RUN_CANCELLED_KEY_PREFIX,
  AGENT_RUN_CONTROL_CHANNEL,
  AGENT_RUN_EVENTS_QUEUE,
  AGENT_RUN_EXECUTION_KEY_PREFIX,
  AGENT_RUN_TASKS_QUEUE,
  AgentRunControlV1Schema,
  RuntimeEventV1Schema,
  RuntimeTaskV1Schema,
  type CapabilityRequestV1,
  type CapabilityResultV1,
  type RuntimeEventV1,
  type RuntimeTaskV1,
} from "@agentmix/core";
import { Job, Queue, QueueEvents, Worker } from "bullmq";
import IORedis from "ioredis";
import type { WorkerConfig } from "./config";
import {
  AgentRuntime,
  createDefaultProvider,
  type RuntimeCapabilityClient,
  type RuntimeEventSink,
} from "./runtime";

const WORKER_CONCURRENCY = 5;
const EXECUTION_MARKER_TTL_SECONDS = 180;
const CANCELLATION_POLL_MS = 250;

export interface DeliveredRunEventState {
  attempt: number;
  sequence: number;
}

export function buildSafeTaskFailureEvents(
  task: RuntimeTaskV1,
  delivered: DeliveredRunEventState | undefined,
  now = Date.now(),
  createId = randomUUID,
): RuntimeEventV1[] {
  const occurredAt = new Date(now).toISOString();
  if (task.kind === "agent.run") {
    const attempt = delivered?.attempt ?? 1;
    const events: RuntimeEventV1[] = [];
    if (!delivered) {
      events.push(
        RuntimeEventV1Schema.parse({
          version: 1,
          kind: "agent.run.event",
          eventId: createId(),
          runId: task.runId,
          conversationId: task.conversationId,
          attempt,
          sequence: 1,
          occurredAt,
          type: "run.started",
        }),
      );
    }
    events.push(RuntimeEventV1Schema.parse({
      version: 1,
      kind: "agent.run.event",
      eventId: createId(),
      runId: task.runId,
      conversationId: task.conversationId,
      attempt,
      sequence: (delivered?.sequence ?? 1) + 1,
      occurredAt,
      type: "run.failed",
      errorCode: "unknown",
      retryable: false,
    }));
    return events;
  }
  return [RuntimeEventV1Schema.parse({
    version: 1,
    kind: "model.check.event",
    eventId: createId(),
    checkId: task.checkId,
    modelProfileId: task.modelProfileId,
    sequence: 2,
    occurredAt,
    type: "model.check.failed",
    status: "failed",
    latencyMs: Math.max(0, now - Date.parse(task.requestedAt)),
    usage: null,
    errorCode: "unknown",
  })];
}

class BullMqEventSink implements RuntimeEventSink {
  constructor(
    private readonly queue: Queue<RuntimeEventV1>,
    private readonly onPublished: (event: RuntimeEventV1) => void,
  ) {}

  async publish(event: RuntimeEventV1): Promise<void> {
    await this.queue.add(event.type, event, {
      jobId: event.eventId,
      attempts: 5,
      backoff: { type: "exponential", delay: 250 },
      removeOnComplete: 2_000,
      removeOnFail: 5_000,
    });
    this.onPublished(event);
  }
}

class BullMqCapabilityClient implements RuntimeCapabilityClient {
  constructor(
    private readonly queue: Queue<CapabilityRequestV1, CapabilityResultV1>,
    private readonly queueEvents: QueueEvents,
  ) {}

  async execute(request: CapabilityRequestV1, signal: AbortSignal): Promise<CapabilityResultV1> {
    const job = await this.queue.add(request.capability, request, {
      jobId: request.requestId,
      removeOnComplete: 2_000,
      removeOnFail: 5_000,
    });
    const timeoutMs = Math.max(1, Date.parse(request.deadlineAt) - Date.now());
    return raceWithAbort(job.waitUntilFinished(this.queueEvents, timeoutMs), signal, job);
  }
}

async function raceWithAbort(
  result: Promise<CapabilityResultV1>,
  signal: AbortSignal,
  job: Job<CapabilityRequestV1, CapabilityResultV1>,
): Promise<CapabilityResultV1> {
  if (signal.aborted) {
    await job.remove().catch(() => undefined);
    throw new Error("Capability request cancelled");
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      void job.remove().catch(() => undefined);
      reject(new Error("Capability request cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([result, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

interface CancellationCommandRedis {
  set(
    key: string,
    value: string,
    expiryMode: "EX",
    time: number,
    setMode: "NX",
  ): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  expire(key: string, seconds: number): Promise<number>;
}

interface CancellationSubscriberRedis {
  on(event: "message", listener: (channel: string, message: string) => void): unknown;
  subscribe(channel: string): Promise<unknown>;
}

export class CancellationRegistry {
  private readonly controllers = new Map<string, Set<AbortController>>();
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private polling = false;

  constructor(
    private readonly command: CancellationCommandRedis,
    private readonly subscriber: CancellationSubscriberRedis,
  ) {}

  async start(): Promise<void> {
    this.subscriber.on("message", (channel, message) => {
      if (channel !== AGENT_RUN_CONTROL_CHANNEL) return;
      let decoded: unknown;
      try {
        decoded = JSON.parse(message);
      } catch {
        return;
      }
      const control = AgentRunControlV1Schema.safeParse(decoded);
      if (!control.success) return;
      for (const controller of this.controllers.get(control.data.runId) ?? []) {
        controller.abort("requested");
      }
    });
    await this.subscriber.subscribe(AGENT_RUN_CONTROL_CHANNEL);
    this.pollTimer = setInterval(() => void this.pollOnce(), CANCELLATION_POLL_MS);
    this.pollTimer.unref();
  }

  /**
   * Pub/sub is intentionally only the low-latency path. Polling the durable
   * marker lets an active Worker observe a cancellation published while its
   * Redis subscription was disconnected.
   */
  async pollOnce(): Promise<void> {
    if (this.polling || this.controllers.size === 0) return;
    this.polling = true;
    try {
      for (const runId of [...this.controllers.keys()]) {
        let cancelled: string | null;
        try {
          cancelled = await this.command.get(`${AGENT_RUN_CANCELLED_KEY_PREFIX}${runId}`);
        } catch {
          continue;
        }
        if (cancelled === null) continue;
        for (const controller of this.controllers.get(runId) ?? []) {
          controller.abort("requested");
        }
      }
    } finally {
      this.polling = false;
    }
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  async register(runId: string): Promise<{ controller: AbortController; replayed: boolean }> {
    const controller = new AbortController();
    const controllers = this.controllers.get(runId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.controllers.set(runId, controllers);
    try {
      const markerKey = `${AGENT_RUN_EXECUTION_KEY_PREFIX}${runId}`;
      const marker = await this.command.set(
        markerKey,
        "1",
        "EX",
        EXECUTION_MARKER_TTL_SECONDS,
        "NX",
      );
      if (marker === null) await this.command.expire(markerKey, EXECUTION_MARKER_TTL_SECONDS);
      const cancelled = await this.command.get(`${AGENT_RUN_CANCELLED_KEY_PREFIX}${runId}`);
      if (cancelled !== null) controller.abort("requested");
      return { controller, replayed: marker === null };
    } catch (error) {
      this.release(runId, controller);
      throw error;
    }
  }

  release(runId: string, controller: AbortController): void {
    const controllers = this.controllers.get(runId);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) this.controllers.delete(runId);
  }

  hasActive(runId: string): boolean {
    return (this.controllers.get(runId)?.size ?? 0) > 0;
  }
}

export interface RunningWorker {
  close(): Promise<void>;
}

export async function startWorker(config: WorkerConfig): Promise<RunningWorker> {
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  const subscriber = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  connection.on("error", () => console.error("[worker] Redis connection error"));
  subscriber.on("error", () => console.error("[worker] Redis subscription error"));

  const eventQueue = new Queue<RuntimeEventV1>(AGENT_RUN_EVENTS_QUEUE, { connection });
  const capabilityQueue = new Queue<CapabilityRequestV1, CapabilityResultV1>(
    AGENT_CAPABILITY_REQUESTS_QUEUE,
    { connection },
  );
  const capabilityEvents = new QueueEvents(AGENT_CAPABILITY_REQUESTS_QUEUE, { connection });
  const pendingCompensations = new Set<Promise<void>>();
  const deliveredRunEvents = new Map<string, DeliveredRunEventState>();
  eventQueue.on("error", () => console.error("[worker] Runtime event queue error"));
  capabilityQueue.on("error", () => console.error("[worker] Capability queue error"));
  capabilityEvents.on("error", () => console.error("[worker] Capability event stream error"));
  const cancellations = new CancellationRegistry(connection, subscriber);
  await cancellations.start();

  const runtime = new AgentRuntime({
    provider: createDefaultProvider(config.openaiApiKey, config.openaiBaseUrl),
    events: new BullMqEventSink(eventQueue, (event) => {
      if (event.kind !== "agent.run.event") return;
      const current = deliveredRunEvents.get(event.runId);
      if (
        !current ||
        event.attempt > current.attempt ||
        (event.attempt === current.attempt && event.sequence > current.sequence)
      ) {
        deliveredRunEvents.set(event.runId, {
          attempt: event.attempt,
          sequence: event.sequence,
        });
      }
    }),
    capabilities: new BullMqCapabilityClient(capabilityQueue, capabilityEvents),
  });

  const worker = new Worker<RuntimeTaskV1>(
    AGENT_RUN_TASKS_QUEUE,
    async (job) => {
      const parsed = RuntimeTaskV1Schema.safeParse(job.data);
      if (!parsed.success) throw new Error("Invalid runtime task payload");
      const task = parsed.data;
      try {
        if (task.kind === "model.check") {
          return { kind: task.kind, checkId: task.checkId, status: await runtime.checkModel(task) };
        }

        const { controller, replayed } = await cancellations.register(task.runId);
        try {
          return {
            kind: task.kind,
            runId: task.runId,
            status: await runtime.run(task, controller.signal, replayed ? 2 : 1),
          };
        } finally {
          cancellations.release(task.runId, controller);
        }
      } catch {
        throw new Error("Runtime task processing failed");
      }
    },
    { connection, concurrency: WORKER_CONCURRENCY },
  );

  worker.on("completed", (job) => {
    console.info(`[worker] job ${job.id ?? "unknown"} completed`);
    const task = RuntimeTaskV1Schema.safeParse(job.data);
    if (
      task.success &&
      task.data.kind === "agent.run" &&
      !cancellations.hasActive(task.data.runId)
    ) {
      deliveredRunEvents.delete(task.data.runId);
    }
  });
  worker.on("failed", (job) => {
    console.error(`[worker] job ${job?.id ?? "unknown"} failed`);
    if (!job) return;
    const task = RuntimeTaskV1Schema.safeParse(job.data);
    if (!task.success) return;
    if (task.data.kind === "agent.run" && cancellations.hasActive(task.data.runId)) return;
    const events = buildSafeTaskFailureEvents(
      task.data,
      task.data.kind === "agent.run" ? deliveredRunEvents.get(task.data.runId) : undefined,
    );
    const compensation = (async () => {
      for (const event of events) {
        await eventQueue.add(event.type, event, {
          jobId: event.eventId,
          attempts: 5,
          backoff: { type: "exponential", delay: 250 },
          removeOnComplete: 2_000,
          removeOnFail: 5_000,
        });
      }
      if (task.data.kind === "agent.run") deliveredRunEvents.delete(task.data.runId);
    })()
      .catch(() => console.error("[worker] failed to publish safe terminal event"));
    pendingCompensations.add(compensation);
    void compensation.finally(() => pendingCompensations.delete(compensation));
  });

  console.info(
    `[worker] listening on queue "${AGENT_RUN_TASKS_QUEUE}" with concurrency ${WORKER_CONCURRENCY}`,
  );

  return {
    async close() {
      await worker.close();
      cancellations.stop();
      if (pendingCompensations.size > 0) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled(pendingCompensations),
            new Promise<void>((resolve) => {
              timeout = setTimeout(resolve, 5_000);
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
      await Promise.all([eventQueue.close(), capabilityQueue.close(), capabilityEvents.close()]);
      subscriber.disconnect();
      connection.disconnect();
    },
  };
}
