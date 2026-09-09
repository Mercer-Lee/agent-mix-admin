import { describe, expect, it } from "vitest";
import {
  AGENT_CAPABILITY_REQUESTS_QUEUE,
  AGENT_RUN_MESSAGE_MAX_CHARS,
  AGENT_RUN_EVENTS_QUEUE,
  AGENT_RUN_TASKS_QUEUE,
  AgentRunControlV1Schema,
  AgentRunEventV1Schema,
  AgentRunTaskV1Schema,
  CapabilityRequestV1Schema,
  ModelCheckTaskV1Schema,
  RuntimeOutboxMessageV1Schema,
  RuntimeTaskV1Schema,
  UsersSearchInputV1Schema,
  UsersSearchOutputV1Schema,
} from "./index";

const ids = {
  run: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  actor: "33333333-3333-4333-8333-333333333333",
  agent: "44444444-4444-4444-8444-444444444444",
  profile: "55555555-5555-4555-8555-555555555555",
  message: "66666666-6666-4666-8666-666666666666",
  event: "77777777-7777-4777-8777-777777777777",
  request: "88888888-8888-4888-8888-888888888888",
};

function validRunTask() {
  return {
    version: 1 as const,
    kind: "agent.run" as const,
    runId: ids.run,
    conversationId: ids.conversation,
    actorSubjectId: ids.actor,
    agentSubjectId: ids.agent,
    traceId: "trace-1",
    model: {
      profileId: ids.profile,
      key: "default",
      modelId: "test-model",
      connectionId: "default" as const,
    },
    generation: { temperature: 0.2, maxOutputTokens: 512, maxSteps: 5 },
    systemPrompt: "You are governed.",
    messages: [{ id: ids.message, role: "user" as const, content: "Hello" }],
    capabilities: ["users.search" as const],
    createdAt: "2026-08-29T10:00:00.000Z",
    deadlineAt: "2026-08-29T10:02:00.000Z",
  };
}

describe("Phase 1C Runtime contracts", () => {
  it("pins the three versioned BullMQ channels", () => {
    expect(AGENT_RUN_TASKS_QUEUE).toBe("agent-run-tasks-v1");
    expect(AGENT_RUN_EVENTS_QUEUE).toBe("agent-run-events-v1");
    expect(AGENT_CAPABILITY_REQUESTS_QUEUE).toBe("agent-capability-requests-v1");
  });

  it("accepts an immutable run snapshot and rejects credentials or future versions", () => {
    expect(AgentRunTaskV1Schema.parse(validRunTask())).toEqual(validRunTask());
    expect(
      AgentRunTaskV1Schema.safeParse({ ...validRunTask(), apiKey: "must-not-enter-a-job" }).success,
    ).toBe(false);
    expect(RuntimeTaskV1Schema.safeParse({ ...validRunTask(), version: 2 }).success).toBe(false);
    expect(
      AgentRunTaskV1Schema.safeParse({
        ...validRunTask(),
        generation: { temperature: 0.2, maxOutputTokens: 512, maxSteps: 6 },
      }).success,
    ).toBe(false);
  });

  it("keeps completed output reusable as bounded conversation history", () => {
    const maximum = "x".repeat(AGENT_RUN_MESSAGE_MAX_CHARS);
    const overflow = `${maximum}x`;
    const completed = {
      version: 1,
      kind: "agent.run.event",
      eventId: ids.event,
      runId: ids.run,
      conversationId: ids.conversation,
      attempt: 1,
      sequence: 2,
      occurredAt: "2026-08-29T10:00:01.000Z",
      type: "run.completed",
      text: maximum,
      finishReason: "length",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };

    expect(AgentRunEventV1Schema.safeParse(completed).success).toBe(true);
    expect(
      AgentRunTaskV1Schema.safeParse({
        ...validRunTask(),
        messages: [{ id: ids.message, role: "assistant", content: maximum }],
      }).success,
    ).toBe(true);
    expect(AgentRunEventV1Schema.safeParse({ ...completed, text: overflow }).success).toBe(false);
    expect(
      AgentRunTaskV1Schema.safeParse({
        ...validRunTask(),
        messages: [{ id: ids.message, role: "assistant", content: overflow }],
      }).success,
    ).toBe(false);
  });

  it("keeps model checks environment-backed", () => {
    const check = {
      version: 1,
      kind: "model.check",
      checkId: ids.request,
      modelProfileId: ids.profile,
      modelId: "test-model",
      connectionId: "default",
      requestedAt: "2026-08-29T10:00:00.000Z",
      deadlineAt: "2026-08-29T10:00:30.000Z",
    };
    expect(ModelCheckTaskV1Schema.safeParse(check).success).toBe(true);
    expect(ModelCheckTaskV1Schema.safeParse({ ...check, baseUrl: "https://example.invalid" }).success).toBe(
      false,
    );
  });

  it("validates ordered retry/reset and terminal event payloads without raw errors", () => {
    const base = {
      version: 1,
      kind: "agent.run.event",
      eventId: ids.event,
      runId: ids.run,
      conversationId: ids.conversation,
      attempt: 2,
      sequence: 1,
      occurredAt: "2026-08-29T10:00:01.000Z",
    };
    expect(
      AgentRunEventV1Schema.safeParse({ ...base, type: "run.reset", reason: "retry" }).success,
    ).toBe(true);
    expect(
      AgentRunEventV1Schema.safeParse({
        ...base,
        type: "run.failed",
        errorCode: "provider_authentication",
        retryable: false,
        rawError: "secret provider response",
      }).success,
    ).toBe(false);
  });

  it("shares the exact users.search input/output shape with the capability bridge", () => {
    expect(UsersSearchInputV1Schema.parse({ search: " admin " })).toEqual({
      page: 1,
      pageSize: 20,
      search: "admin",
    });
    expect(
      UsersSearchOutputV1Schema.safeParse({ items: [], total: 0, page: 1, pageSize: 20 }).success,
    ).toBe(true);

    const request = {
      version: 1,
      kind: "capability.request",
      requestId: ids.request,
      runId: ids.run,
      conversationId: ids.conversation,
      actorSubjectId: ids.actor,
      agentSubjectId: ids.agent,
      traceId: "trace-1",
      capability: "users.search",
      input: { search: "admin" },
      requestedAt: "2026-08-29T10:00:01.000Z",
      deadlineAt: "2026-08-29T10:02:00.000Z",
    };
    expect(CapabilityRequestV1Schema.parse(request).input).toEqual({
      page: 1,
      pageSize: 20,
      search: "admin",
    });
  });

  it("accepts durable cancellation controls in the outbox but never as Worker tasks", () => {
    const control = AgentRunControlV1Schema.parse({
      version: 1,
      kind: "agent.run.cancel",
      runId: ids.run,
      requestedAt: "2026-08-29T10:00:01.000Z",
    });

    expect(RuntimeOutboxMessageV1Schema.parse(control)).toEqual(control);
    expect(RuntimeTaskV1Schema.safeParse(control).success).toBe(false);
  });
});
