import { randomUUID } from "node:crypto";
import {
  AgentRunControlV1Schema,
  AgentRunEventV1Schema,
  type AgentRunEventV1,
  type AgentRunTaskV1,
  type CapabilityRequestV1,
} from "@agentmix/core";
import { describe, expect, it, vi } from "vitest";
import {
  decideAgentRunEventProjection,
  capabilityRequestFailureCode,
  createRuntimeTaskProducerConnectionOptions,
  deliverAgentRunCancellation,
  executeWithSafeQueueError,
  runSafelyInBackground,
} from "./runtime.service";

function event(
  type: AgentRunEventV1["type"],
  attempt: 1 | 2,
  sequence: number,
): AgentRunEventV1 {
  const base = {
    version: 1 as const,
    kind: "agent.run.event" as const,
    eventId: randomUUID(),
    runId: randomUUID(),
    conversationId: "22222222-2222-4222-8222-222222222222",
    attempt,
    sequence,
    occurredAt: new Date().toISOString(),
  };
  if (type === "run.reset") {
    return AgentRunEventV1Schema.parse({ ...base, type, reason: "retry" });
  }
  if (type === "text.delta") {
    return AgentRunEventV1Schema.parse({ ...base, type, delta: "delta" });
  }
  if (type === "run.completed") {
    return AgentRunEventV1Schema.parse({
      ...base,
      type,
      text: "answer",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
  }
  return AgentRunEventV1Schema.parse({ ...base, type });
}

const conversationId = "22222222-2222-4222-8222-222222222222";

function capabilityFixture() {
  const now = Date.parse("2026-08-30T10:00:00.000Z");
  const snapshot: AgentRunTaskV1 = {
    version: 1,
    kind: "agent.run",
    runId: "11111111-1111-4111-8111-111111111111",
    conversationId,
    actorSubjectId: "33333333-3333-4333-8333-333333333333",
    agentSubjectId: "44444444-4444-4444-8444-444444444444",
    traceId: "trace-capability-test",
    model: {
      profileId: "55555555-5555-4555-8555-555555555555",
      key: "default",
      modelId: "test-model",
      connectionId: "default",
    },
    generation: { temperature: 0, maxOutputTokens: 128, maxSteps: 5 },
    systemPrompt: "",
    messages: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        role: "user",
        content: "Find a user",
      },
    ],
    capabilities: ["users.search"],
    createdAt: new Date(now - 1_000).toISOString(),
    deadlineAt: new Date(now + 60_000).toISOString(),
  };
  const request: CapabilityRequestV1 = {
    version: 1,
    kind: "capability.request",
    requestId: "77777777-7777-4777-8777-777777777777",
    runId: snapshot.runId,
    conversationId: snapshot.conversationId,
    actorSubjectId: snapshot.actorSubjectId,
    agentSubjectId: snapshot.agentSubjectId,
    traceId: snapshot.traceId,
    capability: "users.search",
    input: { page: 1, pageSize: 20 },
    requestedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 30_000).toISOString(),
  };
  const run = {
    status: "running" as const,
    conversationId: snapshot.conversationId,
    actorSubjectId: snapshot.actorSubjectId,
    agentSubjectId: snapshot.agentSubjectId,
    cancelRequestedAt: null,
    executionSnapshot: snapshot as unknown as Record<string, unknown>,
  };
  return { now, snapshot, request, run };
}

describe("Runtime event projection ordering", () => {
  it("rejects every stale-attempt event before it can enter the SSE-visible table", () => {
    const run = { status: "running" as const, attempt: 2, conversationId };
    expect(decideAgentRunEventProjection(run, event("text.delta", 1, 20), null)).toBe(
      "discard",
    );
    expect(decideAgentRunEventProjection(run, event("run.completed", 1, 21), null)).toBe(
      "discard",
    );
  });

  it("requires reset to advance an attempt and keeps start monotonic", () => {
    const attemptOne = { status: "running" as const, attempt: 1, conversationId };
    expect(decideAgentRunEventProjection(attemptOne, event("run.started", 2, 1), null)).toBe(
      "retry",
    );
    expect(decideAgentRunEventProjection(attemptOne, event("run.reset", 2, 1), null)).toBe(
      "persist",
    );

    const attemptTwo = { ...attemptOne, attempt: 2 };
    expect(decideAgentRunEventProjection(attemptTwo, event("run.started", 2, 2), 1)).toBe(
      "persist",
    );
    expect(decideAgentRunEventProjection(attemptTwo, event("run.started", 1, 2), 1)).toBe(
      "discard",
    );
  });

  it("discards duplicate/descending sequences and retries gaps", () => {
    const run = { status: "running" as const, attempt: 1, conversationId };
    expect(decideAgentRunEventProjection(run, event("text.delta", 1, 2), 1)).toBe("persist");
    expect(decideAgentRunEventProjection(run, event("text.delta", 1, 1), 1)).toBe("discard");
    expect(decideAgentRunEventProjection(run, event("text.delta", 1, 3), 1)).toBe("retry");
  });

  it("retries a terminal until its attempt start is durable, then persists it", () => {
    const queued = { status: "queued" as const, attempt: 0, conversationId };
    expect(decideAgentRunEventProjection(queued, event("run.completed", 1, 2), null)).toBe(
      "retry",
    );

    const running = { status: "running" as const, attempt: 1, conversationId };
    expect(decideAgentRunEventProjection(running, event("run.completed", 1, 2), 1)).toBe(
      "persist",
    );
    expect(decideAgentRunEventProjection(running, event("run.completed", 2, 1), null)).toBe(
      "retry",
    );
  });
});

describe("Runtime queue error safety", () => {
  it("uses a fail-fast Redis producer while dispatch holds a database row lock", () => {
    expect(createRuntimeTaskProducerConnectionOptions("redis://127.0.0.1:6379")).toEqual({
      url: "redis://127.0.0.1:6379",
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  });

  it("replaces persisted BullMQ failures without retaining sensitive causes", async () => {
    const sentinel = "SECRET_SQL_PARAMETER";

    try {
      await executeWithSafeQueueError("Runtime event processing failed", async () => {
        throw new Error(`database failure containing ${sentinel}`);
      });
      throw new Error("Expected executeWithSafeQueueError to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const safeError = error as Error & { cause?: unknown };
      expect(safeError.message).toBe("Runtime event processing failed");
      expect(Object.hasOwn(safeError, "cause")).toBe(false);
      expect(safeError.message).not.toContain(sentinel);
      expect(safeError.stack).not.toContain(sentinel);
    }
  });

  it("logs only a fixed message when detached background work rejects", async () => {
    const messages: string[] = [];
    const sentinel = "SECRET_SQL_PARAMETER";

    runSafelyInBackground(
      { error: (message) => void messages.push(message) },
      "Runtime watchdog reconciliation failed",
      async () => {
        throw new Error(`database failure containing ${sentinel}`);
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(messages).toEqual(["Runtime watchdog reconciliation failed"]);
    expect(JSON.stringify(messages)).not.toContain(sentinel);
  });
});

describe("Runtime cancellation delivery", () => {
  it("requires marker, pubsub, and queued-job cleanup before delivery succeeds", async () => {
    const control = AgentRunControlV1Schema.parse({
      version: 1,
      kind: "agent.run.cancel",
      runId: "11111111-1111-4111-8111-111111111111",
      requestedAt: new Date().toISOString(),
    });
    const steps: string[] = [];

    await expect(
      deliverAgentRunCancellation(control, {
        setMarker: async () => void steps.push("marker"),
        publish: async () => void steps.push("publish"),
        removeQueuedTask: async () => {
          steps.push("remove");
          throw new Error("redis disconnected");
        },
      }),
    ).rejects.toThrow("redis disconnected");
    expect(steps).toEqual(["marker", "publish", "remove"]);
  });

  it("does not report success when pubsub delivery fails", async () => {
    const control = AgentRunControlV1Schema.parse({
      version: 1,
      kind: "agent.run.cancel",
      runId: "11111111-1111-4111-8111-111111111111",
      requestedAt: new Date().toISOString(),
    });
    const removeQueuedTask = vi.fn();

    await expect(
      deliverAgentRunCancellation(control, {
        setMarker: async () => undefined,
        publish: async () => {
          throw new Error("redis disconnected");
        },
        removeQueuedTask,
      }),
    ).rejects.toThrow("redis disconnected");
    expect(removeQueuedTask).not.toHaveBeenCalled();
  });
});

describe("Runtime capability snapshot binding", () => {
  it("accepts only a live request bound to the immutable run snapshot", () => {
    const fixture = capabilityFixture();
    expect(
      capabilityRequestFailureCode(fixture.run, fixture.request, fixture.now),
    ).toBeNull();
  });

  it("rejects expired capability requests before execution", () => {
    const fixture = capabilityFixture();
    expect(
      capabilityRequestFailureCode(
        fixture.run,
        { ...fixture.request, deadlineAt: new Date(fixture.now).toISOString() },
        fixture.now,
      ),
    ).toBe("CAPABILITY_TIMEOUT");
  });

  it("rejects trace, capability, and deadline escalation outside the snapshot", () => {
    const fixture = capabilityFixture();
    expect(
      capabilityRequestFailureCode(
        fixture.run,
        { ...fixture.request, traceId: "replayed-trace" },
        fixture.now,
      ),
    ).toBe("CAPABILITY_FORBIDDEN");
    expect(
      capabilityRequestFailureCode(
        { ...fixture.run, executionSnapshot: { ...fixture.snapshot, capabilities: [] } },
        fixture.request,
        fixture.now,
      ),
    ).toBe("CAPABILITY_FORBIDDEN");
    expect(
      capabilityRequestFailureCode(
        fixture.run,
        {
          ...fixture.request,
          requestedAt: new Date(Date.parse(fixture.snapshot.createdAt) - 1).toISOString(),
        },
        fixture.now,
      ),
    ).toBe("CAPABILITY_FORBIDDEN");
    expect(
      capabilityRequestFailureCode(
        fixture.run,
        {
          ...fixture.request,
          deadlineAt: new Date(Date.parse(fixture.snapshot.deadlineAt) + 1).toISOString(),
        },
        fixture.now,
      ),
    ).toBe("CAPABILITY_FORBIDDEN");
  });
});
