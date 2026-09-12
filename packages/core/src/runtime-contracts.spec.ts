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
  deriveProviderToolName,
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

/**
 * Top-level fields an issue points at, so a rejection stays diagnosable.
 * Zod reports unrecognized object keys in the message rather than the path.
 */
function issuePaths(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) {
  return (result.error?.issues ?? []).map((issue) => {
    if (issue.path.length) return String(issue.path[0]);
    return /Unrecognized key: "([^"]+)"/.exec(issue.message)?.[1] ?? "undefined";
  });
}

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

describe("Phase 2A MCP tool contracts", () => {
  it("carries model-facing tool descriptors in the run snapshot while staying backward compatible", () => {
    const withTools = {
      ...validRunTask(),
      capabilities: ["users.search", "mcp-docs.search_docs"],
      tools: [
        {
          id: "users.search",
          name: "users_search",
          description: "Search governed users.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          id: "mcp-docs.search_docs",
          name: "search_docs",
          description: "Search the handbook.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    };
    expect(AgentRunTaskV1Schema.parse(withTools).tools).toHaveLength(2);
    // Pre-2A snapshots without descriptors keep parsing.
    expect(AgentRunTaskV1Schema.safeParse(validRunTask()).success).toBe(true);
    // Provider tool names must stay provider-safe.
    expect(
      AgentRunTaskV1Schema.safeParse({
        ...withTools,
        tools: [{ ...withTools.tools[0], name: "invalid name!" }],
      }).success,
    ).toBe(false);
  });

  it("publishes the same invocable set in capabilities and tools", () => {
    // RuntimeService authorizes every incoming capability request against the
    // run snapshot, and the Worker builds its provider tool set from `tools`.
    // The two must describe one set: a snapshot allowed to advertise more than
    // it hands the model would authorize calls the model could not have made,
    // and advertising less would reject legitimate MCP tool calls.
    const published = {
      ...validRunTask(),
      capabilities: ["users.search", "mcp-docs.search_docs"],
      tools: [
        {
          id: "users.search",
          name: "users_search",
          description: "Search governed users.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          id: "mcp-docs.search_docs",
          name: "search_docs-926677e1",
          description: "Search the handbook.",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
        },
      ],
    };
    const task = AgentRunTaskV1Schema.parse(published);
    expect(task.capabilities).toEqual(task.tools?.map((tool) => tool.id));
  });

  it("derives provider-safe, unique tool names for capability ids", () => {
    // A capability id always carries the module separator, which providers
    // reject, so even a short id is rewritten into a clean function name.
    const shortId = deriveProviderToolName("mcp-docs.search");
    expect(shortId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(shortId).toContain("search");
    // A long id keeps the readable action and stays inside the 64-char limit.
    const longId = `mcp-${"a".repeat(60)}.get_workspace_info`;
    const derived = deriveProviderToolName(longId);
    expect(derived).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(derived).toContain("get_workspace_info");
    expect(derived.length).toBeLessThanOrEqual(64);
    // The real collision case: two servers expose a tool with the SAME remote
    // name, so only the derived digest keeps them apart.
    expect(deriveProviderToolName("mcp-docs.search")).not.toBe(
      deriveProviderToolName("mcp-github.search"),
    );
    expect(deriveProviderToolName("mcp-docs.search")).toContain("search");
    // Same for long names where the action segment is truncated.
    const other = deriveProviderToolName(`mcp-${"b".repeat(60)}.get_workspace_info`);
    expect(other).not.toBe(derived);
    expect(deriveProviderToolName(`mcp-docs.${"a".repeat(60)}`)).not.toBe(
      deriveProviderToolName(`mcp-github.${"a".repeat(60)}`),
    );
    // Derivation is stable across calls and processes.
    expect(deriveProviderToolName(longId)).toBe(derived);
    // Every id the contract's own pattern admits yields a provider-safe name.
    for (const id of [
      "users.search",
      "mcp-integration-mcp.get_workspace_info",
      `mcp-${"z".repeat(63)}.${"t".repeat(64)}`,
    ]) {
      expect(deriveProviderToolName(id)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it("accepts pattern-based capability ids and keeps users.search requests strictly typed", () => {
    const base = {
      version: 1,
      kind: "capability.request",
      requestId: ids.request,
      runId: ids.run,
      conversationId: ids.conversation,
      actorSubjectId: ids.actor,
      agentSubjectId: ids.agent,
      traceId: "trace-1",
      requestedAt: "2026-08-29T10:00:01.000Z",
      deadlineAt: "2026-08-29T10:02:00.000Z",
    };
    expect(
      CapabilityRequestV1Schema.safeParse({
        ...base,
        capability: "mcp-docs.search_docs",
        input: { query: "handbook" },
      }).success,
    ).toBe(true);
    expect(
      CapabilityRequestV1Schema.safeParse({
        ...base,
        capability: "mcp-docs.search_docs",
        input: { nested: { deep: [1, "two", null] } },
      }).success,
    ).toBe(true);
    // An ill-typed users.search input must not fall through as generic JSON,
    // and the rejection must still point at the input rather than collapsing
    // into an opaque union error on `capability`.
    const illTypedUsersSearch = CapabilityRequestV1Schema.safeParse({
      ...base,
      capability: "users.search",
      input: { page: "not-a-number" },
    });
    expect(illTypedUsersSearch.success).toBe(false);
    expect(issuePaths(illTypedUsersSearch)).toContain("input");
    // Capability ids stay in module.action format.
    const malformedId = CapabilityRequestV1Schema.safeParse({
      ...base,
      capability: "Not A Capability",
      input: {},
    });
    expect(malformedId.success).toBe(false);
    expect(issuePaths(malformedId)).toContain("capability");
    // An unknown envelope field is reported on that field, not swallowed.
    const unknownField = CapabilityRequestV1Schema.safeParse({
      ...base,
      capability: "mcp-docs.search_docs",
      input: {},
      unexpected: true,
    });
    expect(unknownField.success).toBe(false);
    expect(issuePaths(unknownField)).toContain("unexpected");
  });
});
