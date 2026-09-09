import { randomUUID } from "node:crypto";
import type { AgentRunTaskV1, ModelCheckTaskV1 } from "@agentmix/core";
import { describe, expect, it } from "vitest";
import { AGENT_RUN_CONTROL_CHANNEL } from "@agentmix/core";
import { buildSafeTaskFailureEvents, CancellationRegistry } from "./bullmq-runtime";

function runTask(): AgentRunTaskV1 {
  return {
    version: 1,
    kind: "agent.run",
    runId: randomUUID(),
    conversationId: randomUUID(),
    actorSubjectId: randomUUID(),
    agentSubjectId: randomUUID(),
    traceId: "trace-compensation-test",
    model: {
      profileId: randomUUID(),
      key: "default",
      modelId: "sentinel-model-id",
      connectionId: "default",
    },
    generation: { temperature: 0, maxOutputTokens: 128, maxSteps: 5 },
    systemPrompt: "sentinel-system-prompt",
    messages: [{ id: randomUUID(), role: "user", content: "sentinel-user-message" }],
    capabilities: ["users.search"],
    createdAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
  };
}

function checkTask(): ModelCheckTaskV1 {
  return {
    version: 1,
    kind: "model.check",
    checkId: randomUUID(),
    modelProfileId: randomUUID(),
    modelId: "sentinel-model-id",
    connectionId: "default",
    requestedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  };
}

describe("BullMQ Runtime recovery", () => {
  it("retains the execution marker until TTL and detects a replay", async () => {
    const markerResults: Array<"OK" | null> = ["OK", null];
    const expired: Array<[string, number]> = [];
    const command = {
      set: async () => markerResults.shift() ?? null,
      get: async () => null,
      expire: async (key: string, seconds: number) => {
        expired.push([key, seconds]);
        return 1;
      },
    };
    const subscriber = {
      on: () => undefined,
      subscribe: async () => 1,
    };
    const registry = new CancellationRegistry(command, subscriber);
    const runId = randomUUID();

    const first = await registry.register(runId);
    registry.release(runId, first.controller);
    const replay = await registry.register(runId);
    registry.release(runId, replay.controller);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(expired).toEqual([[expect.stringContaining(runId), 180]]);
  });

  it("aborts every active controller registered for the same run", async () => {
    let onMessage: ((channel: string, message: string) => void) | undefined;
    const command = {
      set: async () => "OK" as const,
      get: async () => null,
      expire: async () => 1,
    };
    const subscriber = {
      on: (_event: "message", listener: (channel: string, message: string) => void) => {
        onMessage = listener;
      },
      subscribe: async () => 1,
    };
    const registry = new CancellationRegistry(command, subscriber);
    await registry.start();
    const runId = randomUUID();
    const first = await registry.register(runId);
    const second = await registry.register(runId);

    onMessage?.(
      AGENT_RUN_CONTROL_CHANNEL,
      JSON.stringify({
        version: 1,
        kind: "agent.run.cancel",
        runId,
        requestedAt: new Date().toISOString(),
      }),
    );

    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(true);
    registry.release(runId, first.controller);
    registry.release(runId, second.controller);
    registry.stop();
  });

  it("recovers a cancellation marker missed while pubsub was disconnected", async () => {
    let cancelled = false;
    const command = {
      set: async () => "OK" as const,
      get: async () => (cancelled ? "1" : null),
      expire: async () => 1,
    };
    const subscriber = {
      on: () => undefined,
      subscribe: async () => 1,
    };
    const registry = new CancellationRegistry(command, subscriber);
    const runId = randomUUID();
    const active = await registry.register(runId);

    cancelled = true;
    await registry.pollOnce();

    expect(active.controller.signal.aborted).toBe(true);
    registry.release(runId, active.controller);
  });

  it("builds terminal compensation events without prompts, model IDs, or raw errors", () => {
    const runEvents = buildSafeTaskFailureEvents(runTask(), undefined);
    const checkEvents = buildSafeTaskFailureEvents(checkTask(), undefined);
    const runEvent = runEvents.at(-1);
    const checkEvent = checkEvents[0];
    const serialized = JSON.stringify([runEvents, checkEvents]);

    expect(runEvents.map((event) => event.type)).toEqual(["run.started", "run.failed"]);
    expect(runEvent).toMatchObject({
      type: "run.failed",
      attempt: 1,
      sequence: 2,
      errorCode: "unknown",
      retryable: false,
    });
    expect(checkEvent).toMatchObject({
      type: "model.check.failed",
      status: "failed",
      errorCode: "unknown",
      usage: null,
    });
    expect(serialized).not.toContain("sentinel-system-prompt");
    expect(serialized).not.toContain("sentinel-user-message");
    expect(serialized).not.toContain("sentinel-model-id");
  });

  it("continues the last delivered attempt/sequence for terminal compensation", () => {
    const events = buildSafeTaskFailureEvents(runTask(), { attempt: 2, sequence: 4 });
    expect(events).toEqual([
      expect.objectContaining({ type: "run.failed", attempt: 2, sequence: 5 }),
    ]);
  });
});
