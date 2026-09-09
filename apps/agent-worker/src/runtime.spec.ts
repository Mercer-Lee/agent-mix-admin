import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AgentRunEventV1,
  AgentRunTaskV1,
  CapabilityRequestV1,
  CapabilityResultV1,
  ModelCheckEventV1,
  ModelCheckTaskV1,
  RuntimeEventV1,
} from "@agentmix/core";
import { AGENT_RUN_MESSAGE_MAX_CHARS } from "@agentmix/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime, createDefaultProvider } from "./runtime";

interface RequestRecord {
  body: Record<string, unknown>;
  authorization: string | undefined;
}

type RequestHandler = (
  request: RequestRecord,
  response: ServerResponse,
  call: number,
) => void | Promise<void>;

const openServers: Array<ReturnType<typeof createServer>> = [];

async function startFakeProvider(handler: RequestHandler) {
  const requests: RequestRecord[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    let rawBody = "";
    for await (const chunk of request) rawBody += String(chunk);
    const record = {
      body: JSON.parse(rawBody) as Record<string, unknown>,
      authorization: request.headers.authorization,
    };
    requests.push(record);
    await handler(record, response, requests.length);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  openServers.push(server);
  const address = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, requests };
}

function sendSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function textChunks(text: string, usage = { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }) {
  return [
    {
      id: "chatcmpl-test",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl-test",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage,
    },
  ];
}

function toolCallChunks() {
  return [
    {
      id: "chatcmpl-tool",
      created: 1,
      model: "test-model",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-users-search",
                type: "function",
                function: { name: "users_search", arguments: '{"search":"admin"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-tool",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    },
  ];
}

function runTask(capabilities: AgentRunTaskV1["capabilities"] = []): AgentRunTaskV1 {
  return {
    version: 1,
    kind: "agent.run",
    runId: randomUUID(),
    conversationId: randomUUID(),
    actorSubjectId: randomUUID(),
    agentSubjectId: randomUUID(),
    traceId: "trace-runtime-test",
    model: {
      profileId: randomUUID(),
      key: "default",
      modelId: "test-model",
      connectionId: "default",
    },
    generation: { temperature: 0, maxOutputTokens: 128, maxSteps: 5 },
    systemPrompt: "Keep the answer short.",
    messages: [{ id: randomUUID(), role: "user", content: "Hello" }],
    capabilities,
    createdAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
  };
}

function modelCheckTask(): ModelCheckTaskV1 {
  return {
    version: 1,
    kind: "model.check",
    checkId: randomUUID(),
    modelProfileId: randomUUID(),
    modelId: "test-model",
    connectionId: "default",
    requestedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 5_000).toISOString(),
  };
}

function createHarness(baseURL: string, capabilityOutput?: CapabilityResultV1) {
  const events: RuntimeEventV1[] = [];
  const requests: CapabilityRequestV1[] = [];
  const runtime = new AgentRuntime({
    provider: createDefaultProvider("sentinel-api-key", baseURL),
    events: { publish: async (event) => void events.push(event) },
    capabilities: {
      execute: async (request) => {
        requests.push(request);
        return (
          capabilityOutput ?? {
            version: 1,
            kind: "capability.result",
            requestId: request.requestId,
            status: "completed",
            output: { items: [], total: 0, page: 1, pageSize: 20 },
            completedAt: new Date().toISOString(),
          }
        );
      },
    },
    deltaFlushMs: 75,
    deltaMaxChars: 256,
  });
  return { runtime, events, requests };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Agent Runtime OpenAI-compatible contract", () => {
  it("streams batched text and bridges users.search through BullMQ-shaped capability contracts", async () => {
    const fake = await startFakeProvider((_request, response, call) => {
      sendSse(response, call === 1 ? toolCallChunks() : textChunks("Hello world"));
    });
    const harness = createHarness(fake.baseURL);
    const task = runTask(["users.search"]);

    await expect(harness.runtime.run(task)).resolves.toBe("completed");
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[0]?.authorization).toBe("Bearer sentinel-api-key");
    expect(harness.requests).toEqual([
      expect.objectContaining({
        runId: task.runId,
        actorSubjectId: task.actorSubjectId,
        agentSubjectId: task.agentSubjectId,
        capability: "users.search",
        input: { page: 1, pageSize: 20, search: "admin" },
      }),
    ]);

    const runEvents = harness.events as AgentRunEventV1[];
    expect(runEvents.map((event) => event.type)).toEqual([
      "run.started",
      "capability.started",
      "capability.completed",
      "text.delta",
      "run.completed",
    ]);
    expect(runEvents.find((event) => event.type === "text.delta")).toMatchObject({
      delta: "Hello world",
    });
    expect(runEvents.find((event) => event.type === "run.completed")).toMatchObject({
      text: "Hello world",
      finishReason: "stop",
    });
    expect(JSON.stringify(runEvents)).not.toContain("sentinel-api-key");
    expect(JSON.stringify(runEvents)).not.toContain(fake.baseURL);
  });

  it("retries only a retryable 429 and resets partial attempt output", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = await startFakeProvider((_request, response, call) => {
      if (call === 1) {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "sentinel-raw-provider-error", type: "rate_limit" } }));
        return;
      }
      sendSse(response, textChunks("Recovered"));
    });
    const harness = createHarness(fake.baseURL);

    await expect(harness.runtime.run(runTask())).resolves.toBe("completed");
    expect(fake.requests).toHaveLength(2);
    expect((harness.events as AgentRunEventV1[]).map((event) => event.type)).toEqual([
      "run.started",
      "run.reset",
      "run.started",
      "text.delta",
      "run.completed",
    ]);
    expect(JSON.stringify(harness.events)).not.toContain("sentinel-raw-provider-error");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not retry authentication failures and emits only a safe code", async () => {
    const fake = await startFakeProvider((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "sentinel-auth-error", type: "auth" } }));
    });
    const harness = createHarness(fake.baseURL);

    await expect(harness.runtime.run(runTask())).resolves.toBe("failed");
    expect(fake.requests).toHaveLength(1);
    expect(harness.events.at(-1)).toMatchObject({
      type: "run.failed",
      errorCode: "provider_authentication",
      retryable: false,
    });
    expect(JSON.stringify(harness.events)).not.toContain("sentinel-auth-error");
  });

  it("rejects an invalid provider stream without returning its raw payload", async () => {
    const fake = await startFakeProvider((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"unexpected":"sentinel-invalid-stream"}\n\ndata: [DONE]\n\n');
    });
    const harness = createHarness(fake.baseURL);

    await expect(harness.runtime.run(runTask())).resolves.toBe("failed");
    expect(fake.requests).toHaveLength(1);
    expect(harness.events.at(-1)).toMatchObject({
      type: "run.failed",
      errorCode: "provider_invalid_response",
      retryable: false,
    });
    expect(JSON.stringify(harness.events)).not.toContain("sentinel-invalid-stream");
  });

  it("cancels an active stream through AbortSignal", async () => {
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const fake = await startFakeProvider((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      requestStarted?.();
      setTimeout(() => response.end("data: [DONE]\n\n"), 250);
    });
    const harness = createHarness(fake.baseURL);
    const controller = new AbortController();
    const running = harness.runtime.run(runTask(), controller.signal);
    await started;
    controller.abort("requested");

    await expect(running).resolves.toBe("cancelled");
    expect(harness.events.at(-1)).toMatchObject({ type: "run.cancelled", reason: "requested" });
  });

  it("reports the total run deadline as a failure, distinct from user cancellation", async () => {
    const fake = await startFakeProvider((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      setTimeout(() => response.end("data: [DONE]\n\n"), 250);
    });
    const harness = createHarness(fake.baseURL);
    const task = runTask();
    task.deadlineAt = new Date(Date.now() + 40).toISOString();

    await expect(harness.runtime.run(task)).resolves.toBe("failed");
    expect(harness.events.at(-1)).toMatchObject({
      type: "run.failed",
      errorCode: "deadline_exceeded",
      retryable: false,
    });
  });

  it("truncates oversized provider output at the durable history boundary", async () => {
    const oversized = "x".repeat(AGENT_RUN_MESSAGE_MAX_CHARS + 17);
    const fake = await startFakeProvider((_request, response) => {
      sendSse(response, textChunks(oversized));
    });
    const harness = createHarness(fake.baseURL);

    await expect(harness.runtime.run(runTask())).resolves.toBe("completed");
    const runEvents = harness.events as AgentRunEventV1[];
    const deltas = runEvents
      .filter((event): event is Extract<AgentRunEventV1, { type: "text.delta" }> =>
        event.type === "text.delta",
      )
      .map((event) => event.delta)
      .join("");
    const completed = runEvents.find(
      (event): event is Extract<AgentRunEventV1, { type: "run.completed" }> =>
        event.type === "run.completed",
    );

    expect(deltas).toHaveLength(AGENT_RUN_MESSAGE_MAX_CHARS);
    expect(completed).toMatchObject({
      text: "x".repeat(AGENT_RUN_MESSAGE_MAX_CHARS),
      finishReason: "length",
    });
  });

  it("propagates a timed delta delivery failure instead of silently dropping buffered text", async () => {
    const fake = await startFakeProvider((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-delivery",
          created: 1,
          model: "test-model",
          choices: [
            { index: 0, delta: { role: "assistant", content: "Buffered" }, finish_reason: null },
          ],
        })}\n\n`,
      );
      setTimeout(() => {
        for (const chunk of textChunks("").slice(1)) {
          response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        response.end("data: [DONE]\n\n");
      }, 120);
    });
    const attempted: RuntimeEventV1[] = [];
    const runtime = new AgentRuntime({
      provider: createDefaultProvider("sentinel-api-key", fake.baseURL),
      events: {
        publish: async (event) => {
          if (event.type === "text.delta") throw new Error("sentinel-event-store-failure");
          attempted.push(event);
        },
      },
      capabilities: {
        execute: async () => {
          throw new Error("not used");
        },
      },
      deltaFlushMs: 40,
    });

    await expect(runtime.run(runTask())).rejects.toThrow("Runtime event delivery failed");
    expect(attempted.map((event) => event.type)).toEqual(["run.started"]);
    expect(JSON.stringify(attempted)).not.toContain("sentinel-event-store-failure");
  });

  it("runs a minimal model check and reports first-token latency plus safe usage", async () => {
    const fake = await startFakeProvider((_request, response) => {
      sendSse(response, textChunks("OK", { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }));
    });
    const harness = createHarness(fake.baseURL);

    await expect(harness.runtime.checkModel(modelCheckTask())).resolves.toBe("succeeded");
    const checkEvents = harness.events as ModelCheckEventV1[];
    expect(checkEvents.map((event) => event.type)).toEqual([
      "model.check.started",
      "model.check.completed",
    ]);
    expect(checkEvents.at(-1)).toMatchObject({
      status: "succeeded",
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    });
  });
});
