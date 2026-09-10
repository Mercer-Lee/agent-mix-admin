import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import {
  AGENT_RUN_CANCEL_OUTBOX_TOPIC,
  AgentRunControlV1Schema,
  AgentRunEventV1Schema,
  AgentRunTaskV1Schema,
  deriveProviderToolName,
  type AgentRunEventV1,
} from "@agentmix/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import cookieParser from "cookie-parser";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AuditService } from "./audit/audit.service";
import { DatabaseService } from "./database/database.service";
import { seedDatabase } from "./database/seed-data";
import {
  agentDepartmentAccessGrants,
  agentRoleAccessGrants,
  agentRunEvents,
  agentRuns,
  agentRuntimes,
  agentUserAccessGrants,
  agents,
  auditLogs,
  conversationMessages,
  conversations,
  departments,
  modelChecks,
  modelProfiles,
  outboxEvents,
  permissions,
  roles,
  sessions,
  subjectPermissions,
  subjectRoles,
  subjects,
  users,
} from "./database/schema";
import { AuthorizationService } from "./rbac/authorization.service";
import { AgentAccessService } from "./agents/agent-access.service";
import { ConversationsService } from "./conversations/conversations.service";
import { ModelsService } from "./models/models.service";
import { RuntimeService } from "./runtime/runtime.service";
import { UsersService } from "./users/users.service";
import { CapabilityExecutor } from "./capabilities/capability.executor";
import { startWorker, type RunningWorker } from "../../agent-worker/src/bullmq-runtime";

process.env.TESTCONTAINERS_RYUK_DISABLED = "true";

function sendSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function textChunks(text: string) {
  return [
    {
      id: "chatcmpl-integration",
      created: 1,
      model: "integration-test-model",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    {
      id: "chatcmpl-integration",
      created: 1,
      model: "integration-test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    },
  ];
}

function toolCallChunks(
  name = "users_search",
  argsJson = '{"search":"admin"}',
  callId = "call-users-search-integration",
) {
  return [
    {
      id: "chatcmpl-tool-integration",
      created: 1,
      model: "integration-test-model",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name, arguments: argsJson },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "chatcmpl-tool-integration",
      created: 1,
      model: "integration-test-model",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    },
  ];
}

function completedRunEvent(input: {
  eventId?: string;
  runId: string;
  conversationId: string;
  attempt: 1 | 2;
  sequence: number;
  text: string;
}): AgentRunEventV1 {
  return AgentRunEventV1Schema.parse({
    version: 1,
    kind: "agent.run.event",
    eventId: input.eventId ?? randomUUID(),
    runId: input.runId,
    conversationId: input.conversationId,
    attempt: input.attempt,
    sequence: input.sequence,
    occurredAt: new Date().toISOString(),
    type: "run.completed",
    text: input.text,
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
}

function projectRuntimeEvent(runtime: RuntimeService, event: AgentRunEventV1): Promise<void> {
  return (
    runtime as unknown as {
      consumeAgentRunEvent(value: AgentRunEventV1): Promise<void>;
    }
  ).consumeAgentRunEvent(event);
}

function createCapabilityGate() {
  let markReached!: () => void;
  let allow!: () => void;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const release = new Promise<void>((resolve) => {
    allow = resolve;
  });
  return { reached, release, markReached, allow };
}

describe("Phase 1C governed runtime", () => {
  let container: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let app: INestApplication;
  let database: DatabaseService;
  let runtimeWorker: RunningWorker;
  let fakeProvider: ReturnType<typeof createServer>;
  let capabilityGate: ReturnType<typeof createCapabilityGate> | null = null;
  let providerToolCallOverride: { name: string; argsJson: string } | null = null;

  beforeAll(async () => {
    [container, redisContainer] = await Promise.all([
      new PostgreSqlContainer(process.env.TEST_POSTGRES_IMAGE ?? "postgres:17-alpine").start(),
      new GenericContainer(process.env.TEST_REDIS_IMAGE ?? "redis:7-alpine")
        .withExposedPorts(6379)
        .start(),
    ]);
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.REDIS_URL = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
    process.env.ADMIN_ORIGIN = "http://localhost:3100";
    process.env.TRUST_PROXY = "127.0.0.0/8,::1/128";
    process.env.SESSION_TTL_HOURS = "12";
    process.env.BOOTSTRAP_ADMIN_USERNAME = "admin";
    process.env.BOOTSTRAP_ADMIN_PASSWORD = "correct-horse-battery-staple";
    process.env.MODEL = "integration-test-model";
    process.env.MCP_E2E_TOKEN = "e2e-mcp-secret-token";

    const migrationPool = new Pool({ connectionString: process.env.DATABASE_URL });
    await migrate(drizzle(migrationPool), {
      migrationsFolder: resolve(process.cwd(), "drizzle"),
    });
    await migrationPool.end();

    const { AppModule } = await import("./app.module");
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app
      .getHttpAdapter()
      .getInstance()
      .set("trust proxy", ["127.0.0.0/8", "::1/128"]);
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix("api");
    await app.init();
    database = app.get(DatabaseService);
    await seedDatabase(database.db, {
      BOOTSTRAP_ADMIN_USERNAME: "admin",
      BOOTSTRAP_ADMIN_PASSWORD: "correct-horse-battery-staple",
      MODEL: "integration-test-model",
    });

    fakeProvider = createServer(async (incoming, response) => {
      let rawBody = "";
      for await (const chunk of incoming) rawBody += String(chunk);
      const body = JSON.parse(rawBody) as {
        tools?: unknown[];
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const hasToolResult = body.messages?.some((message) => message.role === "tool") ?? false;
      const isRevocationProbe =
        body.messages?.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes("CAPABILITY_REVOCATION_PROBE"),
        ) ?? false;
      if (body.tools?.length && !hasToolResult && isRevocationProbe && capabilityGate) {
        capabilityGate.markReached();
        await capabilityGate.release;
      }
      if (body.tools?.length && !hasToolResult) {
        sendSse(
          response,
          providerToolCallOverride
            ? toolCallChunks(providerToolCallOverride.name, providerToolCallOverride.argsJson, "call-mcp-tool-integration")
            : toolCallChunks(),
        );
      } else if (body.tools?.length) {
        sendSse(response, textChunks("Found the governed administrator account."));
      } else {
        sendSse(response, textChunks("OK"));
      }
    });
    await new Promise<void>((resolve) => fakeProvider.listen(0, "127.0.0.1", resolve));
    const providerAddress = fakeProvider.address() as AddressInfo;
    runtimeWorker = await startWorker({
      redisUrl: process.env.REDIS_URL,
      openaiApiKey: "integration-sentinel-api-key",
      openaiBaseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
    });
  });

  afterAll(async () => {
    await runtimeWorker?.close();
    await app?.close();
    await new Promise<void>((resolve) => fakeProvider?.close(() => resolve()));
    await Promise.all([container?.stop(), redisContainer?.stop()]);
  });

  it("runs migrations and Phase 1C bootstrap seed idempotently", async () => {
    await seedDatabase(database.db, {
      BOOTSTRAP_ADMIN_USERNAME: "admin",
      BOOTSTRAP_ADMIN_PASSWORD: "correct-horse-battery-staple",
      MODEL: "integration-test-model",
    });
    const [userCount, roleCount, modelCount, systemAgentCount] = await Promise.all([
      database.db.select({ value: count() }).from(users).where(eq(users.username, "admin")),
      database.db.select({ value: count() }).from(roles).where(eq(roles.key, "super-admin")),
      database.db
        .select({ value: count() })
        .from(modelProfiles)
        .where(eq(modelProfiles.key, "default")),
      database.db
        .select({ value: count() })
        .from(agents)
        .where(eq(agents.slug, "agentmix-assistant")),
    ]);
    expect(userCount[0]?.value).toBe(1);
    expect(roleCount[0]?.value).toBe(1);
    expect(modelCount[0]?.value).toBe(1);
    expect(systemAgentCount[0]?.value).toBe(1);

    const systemAgent = await database.db
      .select({
        id: agents.subjectId,
        isSystem: agents.isSystem,
        modelId: modelProfiles.modelId,
        runtimeAgentId: agentRuntimes.agentSubjectId,
      })
      .from(agents)
      .innerJoin(agentRuntimes, eq(agentRuntimes.agentSubjectId, agents.subjectId))
      .innerJoin(modelProfiles, eq(modelProfiles.id, agentRuntimes.modelProfileId))
      .where(eq(agents.slug, "agentmix-assistant"));
    expect(systemAgent).toEqual([
      expect.objectContaining({
        isSystem: true,
        modelId: "integration-test-model",
        runtimeAgentId: systemAgent[0]?.id,
      }),
    ]);
    const explicitAccess = await database.db
      .select({ agentSubjectId: agentRoleAccessGrants.agentSubjectId })
      .from(agentRoleAccessGrants)
      .where(eq(agentRoleAccessGrants.agentSubjectId, systemAgent[0]!.id));
    expect(explicitAccess).toHaveLength(1);
  });

  it("reports database health", async () => {
    await request(app.getHttpServer()).get("/api/health").expect(200).expect(({ body }) => {
      expect(body).toMatchObject({
        status: "ok",
        database: { status: "ok" },
        redis: { status: "ok" },
        worker: { status: "ok" },
      });
    });
  });

  it("rolls back a governed state change when its audit write fails", async () => {
    const modelsService = app.get(ModelsService);
    const audit = app.get(AuditService);
    const adminUser = await database.db
      .select({ id: users.subjectId })
      .from(users)
      .where(eq(users.username, "admin"))
      .limit(1);
    const originalRecord = audit.record.bind(audit);
    const recordSpy = vi.spyOn(audit, "record").mockImplementation(async (event, transaction) => {
      if (event.action === "model.created") throw new Error("synthetic audit failure");
      await originalRecord(event, transaction);
    });

    try {
      await expect(
        modelsService.create(
          {
            key: "audit-rollback-probe",
            name: "Audit Rollback Probe",
            description: "Must not survive a failed audit write.",
            modelId: "integration-test-model",
            status: "active",
          },
          { actorSubjectId: adminUser[0]!.id, ipAddress: null, userAgent: null },
        ),
      ).rejects.toThrow("synthetic audit failure");
    } finally {
      recordSpy.mockRestore();
    }

    const persisted = await database.db
      .select({ id: modelProfiles.id })
      .from(modelProfiles)
      .where(eq(modelProfiles.key, "audit-rollback-probe"));
    expect(persisted).toHaveLength(0);
  });

  it("rechecks deletion under the conversation lock before appending a message", async () => {
    const conversationsService = app.get(ConversationsService);
    const [adminUser, systemAgent] = await Promise.all([
      database.db
        .select({ id: users.subjectId })
        .from(users)
        .where(eq(users.username, "admin"))
        .limit(1),
      database.db
        .select({ id: agents.subjectId })
        .from(agents)
        .where(eq(agents.slug, "agentmix-assistant"))
        .limit(1),
    ]);
    const created = await database.db
      .insert(conversations)
      .values({
        userSubjectId: adminUser[0]!.id,
        agentSubjectId: systemAgent[0]!.id,
        title: "Deletion race probe",
      })
      .returning({ id: conversations.id });
    const actor = { actorSubjectId: adminUser[0]!.id, ipAddress: null, userAgent: null };
    const snapshotGate = createCapabilityGate();
    const serviceWithSnapshot = conversationsService as unknown as {
      resolveRuntimeSnapshot(userSubjectId: string, agentSubjectId: string): Promise<unknown>;
    };
    const originalResolveSnapshot = serviceWithSnapshot.resolveRuntimeSnapshot.bind(
      conversationsService,
    );
    const snapshotSpy = vi
      .spyOn(serviceWithSnapshot, "resolveRuntimeSnapshot")
      .mockImplementation(async (userSubjectId, agentSubjectId) => {
        const snapshot = await originalResolveSnapshot(userSubjectId, agentSubjectId);
        snapshotGate.markReached();
        await snapshotGate.release;
        return snapshot;
      });

    try {
      const append = conversationsService.addMessage(
        created[0]!.id,
        "This message must not be persisted.",
        randomUUID(),
        actor,
      );
      await snapshotGate.reached;
      await conversationsService.softDelete(created[0]!.id, actor);
      snapshotGate.allow();
      await expect(append).rejects.toThrow("Conversation not found");
    } finally {
      snapshotGate.allow();
      snapshotSpy.mockRestore();
    }

    const [conversationRows, messageRows, runRows] = await Promise.all([
      database.db
        .select({ deletedAt: conversations.deletedAt })
        .from(conversations)
        .where(eq(conversations.id, created[0]!.id)),
      database.db
        .select({ value: count() })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, created[0]!.id)),
      database.db
        .select({ value: count() })
        .from(agentRuns)
        .where(eq(agentRuns.conversationId, created[0]!.id)),
    ]);
    expect(conversationRows[0]?.deletedAt).toBeInstanceOf(Date);
    expect(messageRows[0]?.value).toBe(0);
    expect(runRows[0]?.value).toBe(0);
  });

  it("rebuilds message history after acquiring the conversation lock", async () => {
    const conversationsService = app.get(ConversationsService);
    const [adminUser, systemAgent, model] = await Promise.all([
      database.db
        .select({ id: users.subjectId })
        .from(users)
        .where(eq(users.username, "admin"))
        .limit(1),
      database.db
        .select({ id: agents.subjectId })
        .from(agents)
        .where(eq(agents.slug, "agentmix-assistant"))
        .limit(1),
      database.db
        .select({ id: modelProfiles.id })
        .from(modelProfiles)
        .where(eq(modelProfiles.key, "default"))
        .limit(1),
    ]);
    const created = await database.db
      .insert(conversations)
      .values({
        userSubjectId: adminUser[0]!.id,
        agentSubjectId: systemAgent[0]!.id,
        title: "History lock probe",
      })
      .returning({ id: conversations.id });
    const serviceWithSnapshot = conversationsService as unknown as {
      resolveRuntimeSnapshot(userSubjectId: string, agentSubjectId: string): Promise<unknown>;
    };
    const originalResolveSnapshot = serviceWithSnapshot.resolveRuntimeSnapshot.bind(
      conversationsService,
    );
    let markSnapshotResolved!: () => void;
    const snapshotResolved = new Promise<void>((resolve) => {
      markSnapshotResolved = resolve;
    });
    const snapshotSpy = vi
      .spyOn(serviceWithSnapshot, "resolveRuntimeSnapshot")
      .mockImplementation(async (userSubjectId, agentSubjectId) => {
        const snapshot = await originalResolveSnapshot(userSubjectId, agentSubjectId);
        markSnapshotResolved();
        return snapshot;
      });
    const lockPool = new Pool({ connectionString: process.env.DATABASE_URL });
    const lockClient = await lockPool.connect();
    let append:
      | ReturnType<ConversationsService["addMessage"]>
      | undefined;

    try {
      await lockClient.query("begin");
      await lockClient.query("select id from conversations where id = $1 for update", [
        created[0]!.id,
      ]);
      append = conversationsService.addMessage(
        created[0]!.id,
        "new question",
        randomUUID(),
        { actorSubjectId: adminUser[0]!.id, ipAddress: null, userAgent: null },
      );
      let appendSettled = false;
      void append.then(
        () => {
          appendSettled = true;
        },
        () => {
          appendSettled = true;
        },
      );
      await snapshotResolved;
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(appendSettled).toBe(false);

      const userMessageId = randomUUID();
      const assistantMessageId = randomUUID();
      const completedRunId = randomUUID();
      const historyStartedAt = new Date(Date.now() - 2_000);
      await lockClient.query(
        `insert into conversation_messages (id, conversation_id, role, content, created_at)
         values ($1, $2, 'user', 'history user', $3),
                ($4, $2, 'assistant', 'history assistant', $5)`,
        [
          userMessageId,
          created[0]!.id,
          historyStartedAt,
          assistantMessageId,
          new Date(historyStartedAt.getTime() + 1_000),
        ],
      );
      await lockClient.query(
        `insert into agent_runs (
           id, conversation_id, requested_by_subject_id, agent_subject_id, model_profile_id,
           user_message_id, assistant_message_id, idempotency_key, request_hash,
           status, attempt, execution_snapshot, started_at, completed_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'completed', 1, $10::jsonb, $11, $11)`,
        [
          completedRunId,
          created[0]!.id,
          adminUser[0]!.id,
          systemAgent[0]!.id,
          model[0]!.id,
          userMessageId,
          assistantMessageId,
          randomUUID(),
          "h".repeat(64),
          JSON.stringify({ version: 1 }),
          new Date(),
        ],
      );
      await lockClient.query("commit");

      const appended = await append;
      const snapshots = await database.db
        .select({ value: agentRuns.executionSnapshot })
        .from(agentRuns)
        .where(eq(agentRuns.id, appended.run.id));
      const messages = (
        snapshots[0]!.value as {
          messages: Array<{ role: "user" | "assistant"; content: string }>;
        }
      ).messages;
      expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
        { role: "user", content: "history user" },
        { role: "assistant", content: "history assistant" },
        { role: "user", content: "new question" },
      ]);
    } finally {
      await lockClient.query("rollback").catch(() => undefined);
      lockClient.release();
      await lockPool.end();
      snapshotSpy.mockRestore();
      await append?.catch(() => undefined);
    }
  });

  it("rejects stale attempt events before persistence and honors durable cancellation", async () => {
    const runtime = app.get(RuntimeService);
    const [adminUser, systemAgent, model] = await Promise.all([
      database.db
        .select({ id: users.subjectId })
        .from(users)
        .where(eq(users.username, "admin"))
        .limit(1),
      database.db
        .select({ id: agents.subjectId })
        .from(agents)
        .where(eq(agents.slug, "agentmix-assistant"))
        .limit(1),
      database.db
        .select({ id: modelProfiles.id })
        .from(modelProfiles)
        .where(eq(modelProfiles.key, "default"))
        .limit(1),
    ]);

    const createRunningRun = async (attempt: 1 | 2, cancelRequestedAt: Date | null = null) => {
      const conversation = await database.db
        .insert(conversations)
        .values({ userSubjectId: adminUser[0]!.id, agentSubjectId: systemAgent[0]!.id })
        .returning({ id: conversations.id });
      const message = await database.db
        .insert(conversationMessages)
        .values({ conversationId: conversation[0]!.id, role: "user", content: "projection test" })
        .returning({ id: conversationMessages.id });
      const run = await database.db
        .insert(agentRuns)
        .values({
          conversationId: conversation[0]!.id,
          requestedBySubjectId: adminUser[0]!.id,
          agentSubjectId: systemAgent[0]!.id,
          modelProfileId: model[0]!.id,
          userMessageId: message[0]!.id,
          idempotencyKey: randomUUID(),
          requestHash: randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", ""),
          executionSnapshot: { schemaVersion: 1 },
          status: "running",
          attempt,
          startedAt: new Date(),
          cancelRequestedAt,
        })
        .returning({ id: agentRuns.id });
      return { conversationId: conversation[0]!.id, runId: run[0]!.id };
    };

    const reordered = await createRunningRun(1);
    await database.db
      .update(agentRuns)
      .set({ status: "queued", attempt: 0, startedAt: null })
      .where(eq(agentRuns.id, reordered.runId));
    const earlyTerminal = completedRunEvent({
      runId: reordered.runId,
      conversationId: reordered.conversationId,
      attempt: 1,
      sequence: 2,
      text: "terminal after retry",
    });
    await expect(projectRuntimeEvent(runtime, earlyTerminal)).rejects.toThrow(
      "Runtime event is waiting for an earlier event",
    );
    expect(
      await database.db
        .select({ id: agentRunEvents.id })
        .from(agentRunEvents)
        .where(eq(agentRunEvents.eventId, earlyTerminal.eventId)),
    ).toHaveLength(0);
    await projectRuntimeEvent(
      runtime,
      AgentRunEventV1Schema.parse({
        version: 1,
        kind: "agent.run.event",
        eventId: randomUUID(),
        runId: reordered.runId,
        conversationId: reordered.conversationId,
        attempt: 1,
        sequence: 1,
        occurredAt: new Date().toISOString(),
        type: "run.started",
      }),
    );
    await projectRuntimeEvent(runtime, earlyTerminal);
    expect(
      await database.db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, reordered.runId)),
    ).toEqual([{ status: "completed" }]);

    const replayed = await createRunningRun(2);
    await database.db.insert(agentRunEvents).values([
      {
        eventId: randomUUID(),
        runId: replayed.runId,
        attempt: 2,
        sequence: 1,
        type: "run.reset",
        payload: { type: "run.reset" },
        occurredAt: new Date(),
      },
      {
        eventId: randomUUID(),
        runId: replayed.runId,
        attempt: 2,
        sequence: 2,
        type: "run.started",
        payload: { type: "run.started" },
        occurredAt: new Date(),
      },
    ]);
    const staleEventId = randomUUID();
    await projectRuntimeEvent(
      runtime,
      completedRunEvent({
        eventId: staleEventId,
        runId: replayed.runId,
        conversationId: replayed.conversationId,
        attempt: 1,
        sequence: 3,
        text: "stale attempt must not win",
      }),
    );
    await projectRuntimeEvent(
      runtime,
      completedRunEvent({
        runId: replayed.runId,
        conversationId: replayed.conversationId,
        attempt: 2,
        sequence: 3,
        text: "current attempt wins",
      }),
    );
    const [replayedRun, staleRows] = await Promise.all([
      database.db
        .select({ status: agentRuns.status, assistantMessageId: agentRuns.assistantMessageId })
        .from(agentRuns)
        .where(eq(agentRuns.id, replayed.runId))
        .limit(1),
      database.db
        .select({ id: agentRunEvents.id })
        .from(agentRunEvents)
        .where(eq(agentRunEvents.eventId, staleEventId)),
    ]);
    expect(replayedRun[0]?.status).toBe("completed");
    expect(staleRows).toHaveLength(0);
    const assistant = await database.db
      .select({ content: conversationMessages.content })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, replayedRun[0]!.assistantMessageId!));
    expect(assistant).toEqual([{ content: "current attempt wins" }]);

    const cancelRequestedAt = new Date();
    const canceled = await createRunningRun(1, cancelRequestedAt);
    await database.db.insert(agentRunEvents).values({
      eventId: randomUUID(),
      runId: canceled.runId,
      attempt: 1,
      sequence: 1,
      type: "run.started",
      payload: { type: "run.started" },
      occurredAt: new Date(),
    });
    const upstreamCompletionId = randomUUID();
    await projectRuntimeEvent(
      runtime,
      completedRunEvent({
        eventId: upstreamCompletionId,
        runId: canceled.runId,
        conversationId: canceled.conversationId,
        attempt: 1,
        sequence: 2,
        text: "must not survive cancellation",
      }),
    );
    const canceledRun = await database.db
      .select({ status: agentRuns.status, assistantMessageId: agentRuns.assistantMessageId })
      .from(agentRuns)
      .where(eq(agentRuns.id, canceled.runId));
    const projectedCancellation = await database.db
      .select({ type: agentRunEvents.type, payload: agentRunEvents.payload })
      .from(agentRunEvents)
      .where(eq(agentRunEvents.eventId, upstreamCompletionId));
    expect(canceledRun).toEqual([{ status: "canceled", assistantMessageId: null }]);
    expect(projectedCancellation).toEqual([
      expect.objectContaining({
        type: "run.cancelled",
        payload: expect.objectContaining({ type: "run.cancelled", reason: "requested" }),
      }),
    ]);
    expect(JSON.stringify(projectedCancellation)).not.toContain("must not survive cancellation");
  });

  it("drains more than one SSE event page before sending the terminal snapshot", async () => {
    const [adminUser, systemAgent, model] = await Promise.all([
      database.db
        .select({ id: users.subjectId })
        .from(users)
        .where(eq(users.username, "admin"))
        .limit(1),
      database.db
        .select({ id: agents.subjectId })
        .from(agents)
        .where(eq(agents.slug, "agentmix-assistant"))
        .limit(1),
      database.db
        .select({ id: modelProfiles.id })
        .from(modelProfiles)
        .where(eq(modelProfiles.key, "default"))
        .limit(1),
    ]);
    const conversation = await database.db
      .insert(conversations)
      .values({ userSubjectId: adminUser[0]!.id, agentSubjectId: systemAgent[0]!.id })
      .returning({ id: conversations.id });
    const backlogMessages = await database.db
      .insert(conversationMessages)
      .values([
        { conversationId: conversation[0]!.id, role: "user", content: "large SSE backlog" },
        { conversationId: conversation[0]!.id, role: "assistant", content: "backlog drained" },
      ])
      .returning({ id: conversationMessages.id, role: conversationMessages.role });
    const userMessage = backlogMessages.find((message) => message.role === "user")!;
    const assistantMessage = backlogMessages.find((message) => message.role === "assistant")!;
    const run = await database.db
      .insert(agentRuns)
      .values({
        conversationId: conversation[0]!.id,
        requestedBySubjectId: adminUser[0]!.id,
        agentSubjectId: systemAgent[0]!.id,
        modelProfileId: model[0]!.id,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        idempotencyKey: randomUUID(),
        requestHash: "d".repeat(64),
        executionSnapshot: { schemaVersion: 1 },
        status: "completed",
        attempt: 1,
        completedAt: new Date(),
      })
      .returning({ id: agentRuns.id });
    await database.db.insert(agentRunEvents).values(
      Array.from({ length: 205 }, (_, index) => ({
        eventId: randomUUID(),
        runId: run[0]!.id,
        attempt: 1,
        sequence: index + 1,
        type: "text.delta",
        payload: { type: "text.delta", delta: `chunk-${index + 1}` },
        occurredAt: new Date(),
      })),
    );

    const admin = request.agent(app.getHttpServer());
    await admin
      .post("/api/auth/login")
      .set("origin", "http://localhost:3100")
      .set("x-forwarded-for", "198.51.100.48")
      .send({ username: "admin", password: "correct-horse-battery-staple" })
      .expect(200);
    const stream = await admin.get(`/api/runs/${run[0]!.id}/events`).expect(200);
    expect(stream.text.match(/event: text\.delta/g)).toHaveLength(205);
    expect(stream.text.lastIndexOf("event: text.delta")).toBeLessThan(
      stream.text.indexOf("event: snapshot"),
    );
  });

  it("re-reads queued cancellation under lock and watchdogs missing terminal delivery", async () => {
    const runtime = app.get(RuntimeService);
    const conversationsService = app.get(ConversationsService);
    const [adminUser, systemAgent, model] = await Promise.all([
      database.db
        .select({ id: users.subjectId })
        .from(users)
        .where(eq(users.username, "admin"))
        .limit(1),
      database.db
        .select({ id: agents.subjectId })
        .from(agents)
        .where(eq(agents.slug, "agentmix-assistant"))
        .limit(1),
      database.db
        .select({ id: modelProfiles.id })
        .from(modelProfiles)
        .where(eq(modelProfiles.key, "default"))
        .limit(1),
    ]);
    const conversation = await database.db
      .insert(conversations)
      .values({ userSubjectId: adminUser[0]!.id, agentSubjectId: systemAgent[0]!.id })
      .returning({ id: conversations.id });
    const message = await database.db
      .insert(conversationMessages)
      .values({ conversationId: conversation[0]!.id, role: "user", content: "cancel race" })
      .returning({ id: conversationMessages.id });
    const run = await database.db
      .insert(agentRuns)
      .values({
        conversationId: conversation[0]!.id,
        requestedBySubjectId: adminUser[0]!.id,
        agentSubjectId: systemAgent[0]!.id,
        modelProfileId: model[0]!.id,
        userMessageId: message[0]!.id,
        idempotencyKey: randomUUID(),
        requestHash: "c".repeat(64),
        executionSnapshot: { schemaVersion: 1 },
      })
      .returning({ id: agentRuns.id });
    await database.db.insert(outboxEvents).values({
      runId: run[0]!.id,
      topic: "agent.run.requested",
      deduplicationKey: run[0]!.id,
      payload: { schemaVersion: 1 },
    });

    const racePool = new Pool({ connectionString: process.env.DATABASE_URL });
    const lockClient = await racePool.connect();
    try {
      await lockClient.query("begin");
      await lockClient.query("select id from agent_runs where id = $1 for update", [run[0]!.id]);
      const cancelPromise = conversationsService.cancel(run[0]!.id, {
        actorSubjectId: adminUser[0]!.id,
        ipAddress: null,
        userAgent: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      await lockClient.query(
        "update agent_runs set status = 'running', attempt = 1, started_at = now() where id = $1",
        [run[0]!.id],
      );
      await lockClient.query("commit");
      await cancelPromise;
    } finally {
      await lockClient.query("rollback").catch(() => undefined);
      lockClient.release();
      await racePool.end();
    }

    const [afterRace, outboxAfterRace, cancelEvents] = await Promise.all([
      database.db
        .select({ status: agentRuns.status, cancelRequestedAt: agentRuns.cancelRequestedAt })
        .from(agentRuns)
        .where(eq(agentRuns.id, run[0]!.id)),
      database.db
        .select({ topic: outboxEvents.topic, status: outboxEvents.status })
        .from(outboxEvents)
        .where(eq(outboxEvents.runId, run[0]!.id)),
      database.db
        .select({ id: agentRunEvents.id })
        .from(agentRunEvents)
        .where(and(eq(agentRunEvents.runId, run[0]!.id), eq(agentRunEvents.type, "run.cancelled"))),
    ]);
    expect(afterRace[0]?.status).toBe("running");
    expect(afterRace[0]?.cancelRequestedAt).toBeInstanceOf(Date);
    expect(outboxAfterRace.map(({ topic }) => topic)).toEqual(
      expect.arrayContaining(["agent.run.requested", AGENT_RUN_CANCEL_OUTBOX_TOPIC]),
    );
    expect(outboxAfterRace.every(({ status }) => ["pending", "published"].includes(status))).toBe(
      true,
    );
    expect(outboxAfterRace).toHaveLength(2);
    expect(cancelEvents).toHaveLength(0);

    await database.db
      .update(outboxEvents)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(outboxEvents.runId, run[0]!.id));
    await runtime.reconcileStaleRuntimeTasks(new Date(Date.now() + 180_000));
    const afterWatchdog = await database.db
      .select({ status: agentRuns.status, errorCode: agentRuns.errorCode })
      .from(agentRuns)
      .where(eq(agentRuns.id, run[0]!.id));
    expect(afterWatchdog).toEqual([{ status: "canceled", errorCode: "cancelled" }]);

    const old = new Date(Date.now() - 180_000);
    const check = await database.db
      .insert(modelChecks)
      .values({
        modelProfileId: model[0]!.id,
        requestedBySubjectId: adminUser[0]!.id,
        status: "running",
        startedAt: old,
        createdAt: old,
        updatedAt: old,
      })
      .returning({ id: modelChecks.id });
    await database.db.insert(outboxEvents).values({
      modelCheckId: check[0]!.id,
      topic: "model.check.requested",
      deduplicationKey: check[0]!.id,
      payload: { schemaVersion: 1 },
      status: "published",
      publishedAt: old,
      createdAt: old,
      updatedAt: old,
    });
    await runtime.reconcileStaleRuntimeTasks();
    const failedCheck = await database.db
      .select({ status: modelChecks.status, errorCode: modelChecks.errorCode })
      .from(modelChecks)
      .where(eq(modelChecks.id, check[0]!.id));
    expect(failedCheck).toEqual([{ status: "failed", errorCode: "deadline_exceeded" }]);
  });

  it("linearizes queued cancellation before final dispatch and delivers control outside the batch mutex", async () => {
    const runtime = app.get(RuntimeService);
    const conversationsService = app.get(ConversationsService);
    const runtimeInternal = runtime as unknown as {
      dispatching: boolean;
      enqueueAgentRunIfDispatchable(outboxEventId: string, task: unknown): Promise<boolean>;
      taskQueue: {
        add(name: string, data: unknown, options: unknown): Promise<unknown>;
        getJob(jobId: string): Promise<unknown | undefined>;
      };
    };
    while (runtimeInternal.dispatching) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    runtimeInternal.dispatching = true;

    let cancelPromise: ReturnType<ConversationsService["cancel"]> | undefined;
    let finalDispatch: Promise<boolean> | undefined;
    const racePool = new Pool({ connectionString: process.env.DATABASE_URL });
    const lockClient = await racePool.connect();
    try {
      const [adminUser, systemAgent, model] = await Promise.all([
        database.db
          .select({ id: users.subjectId })
          .from(users)
          .where(eq(users.username, "admin"))
          .limit(1),
        database.db
          .select({ id: agents.subjectId })
          .from(agents)
          .where(eq(agents.slug, "agentmix-assistant"))
          .limit(1),
        database.db
          .select({ id: modelProfiles.id })
          .from(modelProfiles)
          .where(eq(modelProfiles.key, "default"))
          .limit(1),
      ]);
      const conversation = await database.db
        .insert(conversations)
        .values({ userSubjectId: adminUser[0]!.id, agentSubjectId: systemAgent[0]!.id })
        .returning({ id: conversations.id });
      const message = await database.db
        .insert(conversationMessages)
        .values({
          conversationId: conversation[0]!.id,
          role: "user",
          content: "cancel must linearize before dispatch",
        })
        .returning({ id: conversationMessages.id });
      const runId = randomUUID();
      const task = AgentRunTaskV1Schema.parse({
        version: 1,
        kind: "agent.run",
        runId,
        conversationId: conversation[0]!.id,
        actorSubjectId: adminUser[0]!.id,
        agentSubjectId: systemAgent[0]!.id,
        traceId: `trace-${runId}`,
        model: {
          profileId: model[0]!.id,
          key: "default",
          modelId: "integration-test-model",
          connectionId: "default",
        },
        generation: { temperature: 0, maxOutputTokens: 128, maxSteps: 5 },
        systemPrompt: "",
        messages: [{ id: message[0]!.id, role: "user", content: "cancel before dispatch" }],
        capabilities: ["users.search"],
        createdAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      });
      await database.db.insert(agentRuns).values({
        id: runId,
        conversationId: conversation[0]!.id,
        requestedBySubjectId: adminUser[0]!.id,
        agentSubjectId: systemAgent[0]!.id,
        modelProfileId: model[0]!.id,
        userMessageId: message[0]!.id,
        idempotencyKey: randomUUID(),
        requestHash: "l".repeat(64),
        executionSnapshot: task as unknown as Record<string, unknown>,
      });
      const requestOutbox = await database.db
        .insert(outboxEvents)
        .values({
          runId,
          topic: "agent.run.requested",
          deduplicationKey: runId,
          payload: task as unknown as Record<string, unknown>,
        })
        .returning({ id: outboxEvents.id });

      await lockClient.query("begin");
      await lockClient.query("select id from agent_runs where id = $1 for update", [runId]);
      cancelPromise = conversationsService.cancel(runId, {
        actorSubjectId: adminUser[0]!.id,
        ipAddress: null,
        userAgent: null,
      });
      await new Promise((resolve) => setTimeout(resolve, 75));
      finalDispatch = runtimeInternal.enqueueAgentRunIfDispatchable(
        requestOutbox[0]!.id,
        task,
      );
      await new Promise((resolve) => setTimeout(resolve, 75));
      await lockClient.query("commit");

      const [canceledRun, dispatched] = await Promise.all([cancelPromise, finalDispatch]);
      expect(canceledRun.status).toBe("canceled");
      expect(dispatched).toBe(false);
      expect(await runtimeInternal.taskQueue.getJob(runId)).toBeUndefined();

      const persistedOutbox = await database.db
        .select({
          topic: outboxEvents.topic,
          status: outboxEvents.status,
          lastErrorCode: outboxEvents.lastErrorCode,
        })
        .from(outboxEvents)
        .where(eq(outboxEvents.runId, runId));
      expect(persistedOutbox).toEqual(
        expect.arrayContaining([
          {
            topic: "agent.run.requested",
            status: "published",
            lastErrorCode: "CANCELED",
          },
          {
            topic: AGENT_RUN_CANCEL_OUTBOX_TOPIC,
            status: "published",
            lastErrorCode: null,
          },
        ]),
      );

      const retryMessage = await database.db
        .insert(conversationMessages)
        .values({
          conversationId: conversation[0]!.id,
          role: "user",
          content: "redis unavailable rollback",
        })
        .returning({ id: conversationMessages.id });
      const retryRunId = randomUUID();
      const retryTask = AgentRunTaskV1Schema.parse({
        ...task,
        runId: retryRunId,
        traceId: `trace-${retryRunId}`,
        messages: [
          { id: retryMessage[0]!.id, role: "user", content: "redis unavailable rollback" },
        ],
        createdAt: new Date().toISOString(),
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
      });
      await database.db.insert(agentRuns).values({
        id: retryRunId,
        conversationId: conversation[0]!.id,
        requestedBySubjectId: adminUser[0]!.id,
        agentSubjectId: systemAgent[0]!.id,
        modelProfileId: model[0]!.id,
        userMessageId: retryMessage[0]!.id,
        idempotencyKey: randomUUID(),
        requestHash: "r".repeat(64),
        executionSnapshot: retryTask as unknown as Record<string, unknown>,
      });
      const retryOutbox = await database.db
        .insert(outboxEvents)
        .values({
          runId: retryRunId,
          topic: "agent.run.requested",
          deduplicationKey: retryRunId,
          payload: retryTask as unknown as Record<string, unknown>,
        })
        .returning({ id: outboxEvents.id });
      const add = vi
        .spyOn(runtimeInternal.taskQueue, "add")
        .mockRejectedValueOnce(new Error("simulated Redis outage"));
      const dispatchStartedAt = Date.now();
      try {
        await expect(
          runtimeInternal.enqueueAgentRunIfDispatchable(retryOutbox[0]!.id, retryTask),
        ).rejects.toThrow("simulated Redis outage");
      } finally {
        add.mockRestore();
      }
      expect(Date.now() - dispatchStartedAt).toBeLessThan(1_000);
      expect(
        await database.db
          .select({ status: outboxEvents.status })
          .from(outboxEvents)
          .where(eq(outboxEvents.id, retryOutbox[0]!.id)),
      ).toEqual([{ status: "pending" }]);
      await database.db.delete(outboxEvents).where(eq(outboxEvents.runId, retryRunId));
      await database.db.delete(agentRuns).where(eq(agentRuns.id, retryRunId));
    } finally {
      await lockClient.query("rollback").catch(() => undefined);
      lockClient.release();
      await racePool.end();
      runtimeInternal.dispatching = false;
      await Promise.allSettled([cancelPromise, finalDispatch].filter(Boolean) as Promise<unknown>[]);
    }
  });

  it("dispatches durable cancellations ahead of task backlogs larger than one batch", async () => {
    const runtime = app.get(RuntimeService);
    const runtimeInternal = runtime as unknown as {
      dispatching: boolean;
      deliverCancellationControl(control: unknown): Promise<void>;
    };
    while (runtimeInternal.dispatching) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    runtimeInternal.dispatching = true;
    const delivery = vi
      .spyOn(runtimeInternal, "deliverCancellationControl")
      .mockRejectedValueOnce(new Error("simulated Redis outage"));
    let deliveryRestored = false;
    try {
    const [adminUser, systemAgent, model] = await Promise.all([
      database.db
        .select({ id: users.subjectId })
        .from(users)
        .where(eq(users.username, "admin"))
        .limit(1),
      database.db
        .select({ id: agents.subjectId })
        .from(agents)
        .where(eq(agents.slug, "agentmix-assistant"))
        .limit(1),
      database.db
        .select({ id: modelProfiles.id })
        .from(modelProfiles)
        .where(eq(modelProfiles.key, "default"))
        .limit(1),
    ]);
    const conversation = await database.db
      .insert(conversations)
      .values({ userSubjectId: adminUser[0]!.id, agentSubjectId: systemAgent[0]!.id })
      .returning({ id: conversations.id });
    const message = await database.db
      .insert(conversationMessages)
      .values({ conversationId: conversation[0]!.id, role: "user", content: "cancel backlog" })
      .returning({ id: conversationMessages.id });
    const run = await database.db
      .insert(agentRuns)
      .values({
        conversationId: conversation[0]!.id,
        requestedBySubjectId: adminUser[0]!.id,
        agentSubjectId: systemAgent[0]!.id,
        modelProfileId: model[0]!.id,
        userMessageId: message[0]!.id,
        idempotencyKey: randomUUID(),
        requestHash: "b".repeat(64),
        executionSnapshot: { schemaVersion: 1 },
        status: "running",
        attempt: 1,
        startedAt: new Date(),
        cancelRequestedAt: new Date(),
      })
      .returning({ id: agentRuns.id });
    await database.db.insert(outboxEvents).values(
      Array.from({ length: 25 }, (_, index) => ({
        runId: run[0]!.id,
        topic: "agent.run.requested",
        deduplicationKey: `cancel-backlog:${run[0]!.id}:${index}`,
        payload: { invalidBacklogIndex: index },
      })),
    );
    const control = AgentRunControlV1Schema.parse({
      version: 1,
      kind: "agent.run.cancel",
      runId: run[0]!.id,
      requestedAt: new Date().toISOString(),
    });
    await database.db.insert(outboxEvents).values({
      runId: run[0]!.id,
      topic: AGENT_RUN_CANCEL_OUTBOX_TOPIC,
      deduplicationKey: `agent.run.cancel:${run[0]!.id}`,
      payload: control as Record<string, unknown>,
    });

    runtimeInternal.dispatching = false;
    const firstDispatch = runtime.dispatchOutboxOnce(run[0]!.id);
    const firstPublished = await firstDispatch;
    runtimeInternal.dispatching = true;
    expect(firstPublished).toBe(24);

    const afterFailure = await database.db
      .select({
        topic: outboxEvents.topic,
        status: outboxEvents.status,
        attempts: outboxEvents.attempts,
        lastErrorCode: outboxEvents.lastErrorCode,
      })
      .from(outboxEvents)
      .where(eq(outboxEvents.runId, run[0]!.id));
    expect(
      afterFailure.find(({ topic }) => topic === AGENT_RUN_CANCEL_OUTBOX_TOPIC),
    ).toMatchObject({
      status: "pending",
      attempts: 1,
      lastErrorCode: "CONTROL_DELIVERY_UNAVAILABLE",
    });
    expect(
      afterFailure.filter(
        ({ topic, status }) => topic === "agent.run.requested" && status === "pending",
      ),
    ).toHaveLength(1);

    delivery.mockRestore();
    deliveryRestored = true;
    await database.db
      .update(outboxEvents)
      .set({ availableAt: new Date() })
      .where(
        and(
          eq(outboxEvents.runId, run[0]!.id),
          eq(outboxEvents.topic, AGENT_RUN_CANCEL_OUTBOX_TOPIC),
        ),
      );
    runtimeInternal.dispatching = false;
    const recoveryDispatch = runtime.dispatchOutboxOnce(run[0]!.id);
    const recoveryPublished = await recoveryDispatch;
    runtimeInternal.dispatching = true;
    expect(recoveryPublished).toBe(2);

    const recovered = await database.db
      .select({ status: outboxEvents.status })
      .from(outboxEvents)
      .where(eq(outboxEvents.runId, run[0]!.id));
    expect(recovered.every(({ status }) => status === "published")).toBe(true);
    } finally {
      if (!deliveryRestored) delivery.mockRestore();
      runtimeInternal.dispatching = false;
    }
  });

  it("disposes deterministic invalid outbox payloads for watchdog reconciliation", async () => {
    const runtime = app.get(RuntimeService);
    const [adminUser, model] = await Promise.all([
      database.db
        .select({ id: users.subjectId })
        .from(users)
        .where(eq(users.username, "admin"))
        .limit(1),
      database.db
        .select({ id: modelProfiles.id })
        .from(modelProfiles)
        .where(eq(modelProfiles.key, "default"))
        .limit(1),
    ]);
    const old = new Date(Date.now() - 180_000);
    const check = await database.db
      .insert(modelChecks)
      .values({
        modelProfileId: model[0]!.id,
        requestedBySubjectId: adminUser[0]!.id,
        createdAt: old,
        updatedAt: old,
      })
      .returning({ id: modelChecks.id });
    const outbox = await database.db
      .insert(outboxEvents)
      .values({
        modelCheckId: check[0]!.id,
        topic: "model.check.requested",
        deduplicationKey: check[0]!.id,
        payload: { schemaVersion: 999, secret: "must-not-be-logged" },
        availableAt: old,
        createdAt: old,
        updatedAt: old,
      })
      .returning({ id: outboxEvents.id });

    await runtime.dispatchOutboxOnce();
    const handled = await database.db
      .select({
        status: outboxEvents.status,
        attempts: outboxEvents.attempts,
        lastErrorCode: outboxEvents.lastErrorCode,
        publishedAt: outboxEvents.publishedAt,
      })
      .from(outboxEvents)
      .where(eq(outboxEvents.id, outbox[0]!.id));
    expect(handled).toEqual([
      {
        status: "published",
        attempts: 1,
        lastErrorCode: "INVALID_OUTBOX_PAYLOAD",
        publishedAt: expect.any(Date),
      },
    ]);

    await runtime.reconcileStaleRuntimeTasks();
    const failedCheck = await database.db
      .select({ status: modelChecks.status, errorCode: modelChecks.errorCode })
      .from(modelChecks)
      .where(eq(modelChecks.id, check[0]!.id));
    expect(failedCheck).toEqual([{ status: "failed", errorCode: "deadline_exceeded" }]);
  });

  it("enforces subtype, non-nested roles, explicit access, and durable run invariants", async () => {
    const invalidSubtype = await database.db
      .insert(subjects)
      .values({ type: "user" })
      .returning({ id: subjects.id });
    await expect(
      database.db.insert(agents).values({
        subjectId: invalidSubtype[0]!.id,
        slug: "invalid-subtype-agent",
        name: "Invalid subtype",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    const nestedRoleSubject = await database.db
      .insert(subjects)
      .values({ type: "role" })
      .returning({ id: subjects.id });
    await database.db.insert(roles).values({
      subjectId: nestedRoleSubject[0]!.id,
      key: "nested-role-candidate",
      name: "Nested role candidate",
    });
    const superAdminRole = await database.db
      .select({ id: roles.subjectId })
      .from(roles)
      .where(eq(roles.key, "super-admin"))
      .limit(1);
    await expect(
      database.db.insert(subjectRoles).values({
        subjectId: nestedRoleSubject[0]!.id,
        roleId: superAdminRole[0]!.id,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    const bareRoleHolder = await database.db
      .insert(subjects)
      .values({ type: "user" })
      .returning({ id: subjects.id });
    await database.db.insert(subjectRoles).values({
      subjectId: bareRoleHolder[0]!.id,
      roleId: superAdminRole[0]!.id,
    });
    await expect(
      database.db
        .update(subjects)
        .set({ type: "role" })
        .where(eq(subjects.id, bareRoleHolder[0]!.id)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    const adminUser = await database.db
      .select({ id: users.subjectId })
      .from(users)
      .where(eq(users.username, "admin"))
      .limit(1);
    await expect(
      database.db.update(subjects).set({ type: "agent" }).where(eq(subjects.id, adminUser[0]!.id)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    const agentSubject = await database.db
      .insert(subjects)
      .values({ type: "agent" })
      .returning({ id: subjects.id });
    await database.db.insert(agents).values({
      subjectId: agentSubject[0]!.id,
      slug: "phase-1c-invariant-agent",
      name: "Phase 1C invariant agent",
    });
    const department = await database.db
      .insert(departments)
      .values({ code: "phase-1c-access", name: "Phase 1C access" })
      .returning({ id: departments.id });
    await Promise.all([
      database.db.insert(agentUserAccessGrants).values({
        agentSubjectId: agentSubject[0]!.id,
        userSubjectId: adminUser[0]!.id,
      }),
      database.db.insert(agentRoleAccessGrants).values({
        agentSubjectId: agentSubject[0]!.id,
        roleSubjectId: superAdminRole[0]!.id,
      }),
      database.db.insert(agentDepartmentAccessGrants).values({
        agentSubjectId: agentSubject[0]!.id,
        departmentId: department[0]!.id,
        includeDescendants: true,
      }),
    ]);
    const departmentGrant = await database.db
      .select({ includeDescendants: agentDepartmentAccessGrants.includeDescendants })
      .from(agentDepartmentAccessGrants)
      .where(eq(agentDepartmentAccessGrants.agentSubjectId, agentSubject[0]!.id));
    expect(departmentGrant).toEqual([{ includeDescendants: true }]);

    const model = await database.db
      .select({ id: modelProfiles.id })
      .from(modelProfiles)
      .where(eq(modelProfiles.key, "default"))
      .limit(1);
    const conversation = await database.db
      .insert(conversations)
      .values({ userSubjectId: adminUser[0]!.id, agentSubjectId: agentSubject[0]!.id })
      .returning({ id: conversations.id });
    const firstMessage = await database.db
      .insert(conversationMessages)
      .values({ conversationId: conversation[0]!.id, role: "user", content: "hello" })
      .returning({ id: conversationMessages.id });
    const idempotencyKey = randomUUID();
    const run = await database.db
      .insert(agentRuns)
      .values({
        conversationId: conversation[0]!.id,
        requestedBySubjectId: adminUser[0]!.id,
        agentSubjectId: agentSubject[0]!.id,
        modelProfileId: model[0]!.id,
        userMessageId: firstMessage[0]!.id,
        idempotencyKey,
        requestHash: "a".repeat(64),
        executionSnapshot: { schemaVersion: 1 },
      })
      .returning({ id: agentRuns.id });
    const concurrentMessage = await database.db
      .insert(conversationMessages)
      .values({ conversationId: conversation[0]!.id, role: "user", content: "concurrent" })
      .returning({ id: conversationMessages.id });
    await expect(
      database.db.insert(agentRuns).values({
        conversationId: conversation[0]!.id,
        requestedBySubjectId: adminUser[0]!.id,
        agentSubjectId: agentSubject[0]!.id,
        modelProfileId: model[0]!.id,
        userMessageId: concurrentMessage[0]!.id,
        idempotencyKey: randomUUID(),
        requestHash: "b".repeat(64),
        executionSnapshot: { schemaVersion: 1 },
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(
      database.db
        .update(agentRuns)
        .set({ executionSnapshot: { schemaVersion: 2 } })
        .where(eq(agentRuns.id, run[0]!.id)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    const eventId = randomUUID();
    await database.db.insert(agentRunEvents).values({
      eventId,
      runId: run[0]!.id,
      attempt: 1,
      sequence: 0,
      type: "agent.run.started",
      occurredAt: new Date(),
    });
    await database.db.insert(agentRunEvents).values({
      eventId: randomUUID(),
      runId: run[0]!.id,
      attempt: 1,
      sequence: 0,
      type: "agent.run.started",
      occurredAt: new Date(),
    });
    await expect(
      database.db.insert(agentRunEvents).values({
        eventId,
        runId: run[0]!.id,
        attempt: 1,
        sequence: 1,
        type: "agent.run.started",
        occurredAt: new Date(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    await database.db.insert(agentRunEvents).values({
      eventId: randomUUID(),
      runId: run[0]!.id,
      attempt: 2,
      sequence: 0,
      type: "agent.run.reset",
      occurredAt: new Date(),
    });
    await database.db.insert(outboxEvents).values({
      runId: run[0]!.id,
      topic: "agent-run-tasks-v1",
      deduplicationKey: run[0]!.id,
      payload: { runId: run[0]!.id },
    });
    await expect(
      database.db.insert(outboxEvents).values({
        topic: "agent-run-tasks-v1",
        deduplicationKey: randomUUID(),
        payload: {},
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    const systemAgent = await database.db
      .select({ id: agents.subjectId })
      .from(agents)
      .where(eq(agents.slug, "agentmix-assistant"))
      .limit(1);
    await expect(
      database.db.delete(agents).where(eq(agents.subjectId, systemAgent[0]!.id)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("rejects foreign origins and generic invalid credentials", async () => {
    await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("x-forwarded-for", "198.51.100.40")
      .send({ username: "admin", password: "correct-horse-battery-staple" })
      .expect(403);

    await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("x-forwarded-for", "198.51.100.41")
      .set("origin", "https://attacker.example")
      .send({ username: "admin", password: "correct-horse-battery-staple" })
      .expect(403);

    await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("x-forwarded-for", "198.51.100.42")
      .set("origin", "http://localhost:3100")
      .send({ username: "missing", password: "incorrect-password" })
      .expect(401)
      .expect(({ body }) => expect(body.message).toBe("Invalid credentials"));
  });

  it("authenticates, applies RBAC immediately, and audits protected operations", async () => {
    const admin = request.agent(app.getHttpServer());
    const login = await admin
      .post("/api/auth/login")
      .set("x-forwarded-for", "198.51.100.43")
      .set("origin", "http://localhost:3100")
      .send({ username: "admin", password: "correct-horse-battery-staple" })
      .expect(200);
    expect(login.headers["set-cookie"]?.[0]).toContain("agentmix_session=");
    expect(login.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(login.body.permissions).toContain("users:read");

    await admin.get("/api/auth/me").expect(200).expect(({ body }) => {
      expect(body.user.username).toBe("admin");
      expect(body.roles[0].key).toBe("super-admin");
    });
    await admin.get("/api/users").expect(200);

    const created = await admin
      .post("/api/users")
      .set("origin", "http://localhost:3100")
      .send({
        username: "operator",
        password: "operator-password-123",
        displayName: "Operator",
      })
      .expect(201);
    expect(created.body).not.toHaveProperty("passwordHash");
    await admin
      .post("/api/users")
      .set("origin", "http://localhost:3100")
      .send({
        username: "operator",
        password: "another-operator-password",
        displayName: "Duplicate Operator",
      })
      .expect(409);
    await admin
      .put("/api/users/not-a-uuid/roles")
      .set("origin", "http://localhost:3100")
      .send({ roleIds: [] })
      .expect(400);

    const operator = request.agent(app.getHttpServer());
    await operator
      .post("/api/auth/login")
      .set("x-forwarded-for", "198.51.100.44")
      .set("origin", "http://localhost:3100")
      .send({ username: "operator", password: "operator-password-123" })
      .expect(200);
    await operator.get("/api/users").expect(403);

    const roleList = await admin.get("/api/roles").expect(200);
    const superAdminId = roleList.body.find(
      (role: { key: string }) => role.key === "super-admin",
    ).id as string;
    await admin
      .put(`/api/users/${created.body.id}/roles`)
      .set("origin", "http://localhost:3100")
      .send({ roleIds: [superAdminId] })
      .expect(204);
    await operator.get("/api/users").expect(200);

    const auditCount = await database.db.select({ value: count() }).from(auditLogs);
    expect(auditCount[0]!.value).toBeGreaterThanOrEqual(6);
    const denied = await database.db
      .select({ action: auditLogs.action, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.action, "authorization.denied"));
    expect(denied).toHaveLength(1);
    expect(JSON.stringify(denied[0]?.metadata)).not.toContain("password");

    await operator
      .post("/api/auth/logout")
      .set("origin", "http://localhost:3100")
      .expect(204);
    await operator.get("/api/auth/me").expect(401);
  });

  it("resolves agent permissions through the same subject and role model", async () => {
    const role = await database.db
      .select({ id: roles.subjectId })
      .from(roles)
      .where(eq(roles.key, "super-admin"))
      .limit(1);
    const agentSubject = await database.db
      .insert(subjects)
      .values({ type: "agent" })
      .returning({ id: subjects.id });
    await database.db.insert(agents).values({
      subjectId: agentSubject[0]!.id,
      slug: "operations-agent",
      name: "Operations Agent",
    });
    await database.db.insert(subjectRoles).values({
      subjectId: agentSubject[0]!.id,
      roleId: role[0]!.id,
    });

    const authorization = app.get(AuthorizationService);
    await expect(authorization.hasPermissions(agentSubject[0]!.id, ["users:read", "roles:read"])).resolves.toBe(true);
  });

  it("discovers and executes users.search only for an authorized user-agent pair", async () => {
    const adminUser = await database.db
      .select({ id: users.subjectId })
      .from(users)
      .where(eq(users.username, "admin"))
      .limit(1);
    const usersReadPermission = await database.db
      .select({ id: permissions.id })
      .from(permissions)
      .where(and(eq(permissions.resource, "users"), eq(permissions.action, "read")))
      .limit(1);
    const allowedAgentSubject = await database.db
      .insert(subjects)
      .values({ type: "agent" })
      .returning({ id: subjects.id });
    await database.db.insert(agents).values({
      subjectId: allowedAgentSubject[0]!.id,
      slug: "user-query-agent",
      name: "User Query Agent",
    });
    await database.db.insert(subjectPermissions).values({
      subjectId: allowedAgentSubject[0]!.id,
      permissionId: usersReadPermission[0]!.id,
    });

    const capabilities = app.get(CapabilityExecutor);
    const context = {
      actorSubjectId: adminUser[0]!.id,
      agentSubjectId: allowedAgentSubject[0]!.id,
      traceId: "integration-users-search",
      conversationId: "integration-conversation",
    };
    await expect(capabilities.listAvailable(context)).resolves.toEqual([
      expect.objectContaining({
        id: "users.search",
        version: "1.0.0",
        requiredPermissions: ["users:read"],
      }),
    ]);
    const result = (await capabilities.execute("users.search", { search: "admin" }, context)) as {
      items: Array<{ username: string }>;
      total: number;
      page: number;
      pageSize: number;
    };
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(result.items.map((item) => item.username)).toEqual(["admin"]);

    const deniedAgentSubject = await database.db
      .insert(subjects)
      .values({ type: "agent" })
      .returning({ id: subjects.id });
    await database.db.insert(agents).values({
      subjectId: deniedAgentSubject[0]!.id,
      slug: "unprivileged-query-agent",
      name: "Unprivileged Query Agent",
    });
    const deniedContext = { ...context, agentSubjectId: deniedAgentSubject[0]!.id };
    await expect(capabilities.listAvailable(deniedContext)).resolves.toEqual([]);
    await expect(capabilities.execute("users.search", {}, deniedContext)).rejects.toMatchObject({
      code: "CAPABILITY_FORBIDDEN",
    });

    const capabilityAudits = await database.db
      .select({
        actorSubjectId: auditLogs.actorSubjectId,
        action: auditLogs.action,
        resourceId: auditLogs.resourceId,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .where(eq(auditLogs.resourceType, "capability"));
    expect(capabilityAudits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorSubjectId: adminUser[0]!.id,
          action: "capability.executed",
          resourceId: "users.search",
          metadata: expect.objectContaining({
            agentSubjectId: allowedAgentSubject[0]!.id,
            traceId: "integration-users-search",
            input: { page: 1, pageSize: 20, hasSearch: true },
            output: { resultCount: 1, total: 1 },
          }),
        }),
        expect.objectContaining({
          actorSubjectId: adminUser[0]!.id,
          action: "capability.authorization.denied",
          resourceId: "users.search",
        }),
      ]),
    );
    expect(JSON.stringify(capabilityAudits)).not.toContain("correct-horse-battery-staple");
  });

  it("runs model check, streamed chat, users.search, idempotency, SSE replay, and audit separation", async () => {
    const admin = request.agent(app.getHttpServer());
    await admin
      .post("/api/auth/login")
      .set("x-forwarded-for", "198.51.100.45")
      .set("origin", "http://localhost:3100")
      .send({ username: "admin", password: "correct-horse-battery-staple" })
      .expect(200);

    const modelList = await admin.get("/api/models").expect(200);
    const defaultModel = modelList.body.items.find(
      (profile: { key: string }) => profile.key === "default",
    ) as { id: string };
    const check = await admin
      .post(`/api/models/${defaultModel.id}/check`)
      .set("origin", "http://localhost:3100")
      .expect(202);
    let checkStatus = check.body;
    for (let index = 0; index < 100 && !["succeeded", "failed"].includes(checkStatus.status); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      checkStatus = (await admin.get(`/api/model-checks/${check.body.id}`).expect(200)).body;
    }
    expect(checkStatus).toMatchObject({ status: "succeeded", usage: { totalTokens: 11 } });

    const available = await admin.get("/api/chat/agents").expect(200);
    const assistant = available.body.items.find(
      (agent: { slug: string }) => agent.slug === "agentmix-assistant",
    ) as { id: string };
    expect(assistant.id).toBeTruthy();

    const idempotencyKey = randomUUID();
    const created = await admin
      .post("/api/conversations")
      .set("origin", "http://localhost:3100")
      .set("idempotency-key", idempotencyKey)
      .send({ agentId: assistant.id, content: "Find the admin user." })
      .expect(202);
    const retried = await admin
      .post("/api/conversations")
      .set("origin", "http://localhost:3100")
      .set("idempotency-key", idempotencyKey)
      .send({ agentId: assistant.id, content: "Find the admin user." })
      .expect(202);
    expect(retried.body.run.id).toBe(created.body.run.id);
    await admin
      .post("/api/conversations")
      .set("origin", "http://localhost:3100")
      .set("idempotency-key", idempotencyKey)
      .send({ agentId: assistant.id, content: "A different request." })
      .expect(409);

    let run = created.body.run;
    for (let index = 0; index < 200 && !["completed", "failed", "canceled"].includes(run.status); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      run = (await admin.get(`/api/runs/${run.id}`).expect(200)).body;
    }
    expect(run).toMatchObject({
      status: "completed",
      usage: { totalTokens: 17 },
      assistantMessage: { content: "Found the governed administrator account." },
    });

    const usersReadPermission = await database.db
      .select({ id: permissions.id })
      .from(permissions)
      .where(and(eq(permissions.resource, "users"), eq(permissions.action, "read")))
      .limit(1);
    const revocationGate = createCapabilityGate();
    capabilityGate = revocationGate;
    let permissionRevoked = false;
    try {
      const revokedRequest = await admin
        .post("/api/conversations")
        .set("origin", "http://localhost:3100")
        .set("idempotency-key", randomUUID())
        .send({ agentId: assistant.id, content: "CAPABILITY_REVOCATION_PROBE" })
        .expect(202);
      await Promise.race([
        revocationGate.reached,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Capability revocation probe did not reach the model")), 5_000),
        ),
      ]);
      await database.db
        .delete(subjectPermissions)
        .where(
          and(
            eq(subjectPermissions.subjectId, assistant.id),
            eq(subjectPermissions.permissionId, usersReadPermission[0]!.id),
          ),
        );
      permissionRevoked = true;
      revocationGate.allow();

      let revokedRun = revokedRequest.body.run;
      for (
        let index = 0;
        index < 200 && !["completed", "failed", "canceled"].includes(revokedRun.status);
        index += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        revokedRun = (await admin.get(`/api/runs/${revokedRun.id}`).expect(200)).body;
      }
      expect(revokedRun).toMatchObject({ status: "failed", errorCode: "capability_failed" });
    } finally {
      revocationGate.allow();
      capabilityGate = null;
      if (permissionRevoked) {
        await database.db
          .insert(subjectPermissions)
          .values({ subjectId: assistant.id, permissionId: usersReadPermission[0]!.id })
          .onConflictDoNothing();
      }
    }

    const persistedEvents = await database.db
      .select({ type: agentRunEvents.type })
      .from(agentRunEvents)
      .where(eq(agentRunEvents.runId, run.id));
    expect(persistedEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "run.started",
        "capability.started",
        "capability.completed",
        "text.delta",
        "run.completed",
      ]),
    );

    const stream = await admin.get(`/api/runs/${run.id}/events`).expect(200);
    expect(stream.text).toContain("event: text.delta");
    expect(stream.text).toContain("event: snapshot");

    const auditMetadata = await admin
      .get(`/api/audit/conversations/${created.body.conversation.id}`)
      .expect(200);
    expect(auditMetadata.body.runs[0]).not.toHaveProperty("executionSnapshot");
    expect(auditMetadata.body.conversation).not.toHaveProperty("title");
    expect(JSON.stringify(auditMetadata.body)).not.toContain("Find the admin user");
    const auditList = await admin.get("/api/audit/conversations").expect(200);
    const listedAudit = auditList.body.items.find(
      (item: { id: string }) => item.id === created.body.conversation.id,
    );
    expect(listedAudit).toBeTruthy();
    expect(listedAudit).not.toHaveProperty("title");
    expect(JSON.stringify(listedAudit)).not.toContain("Find the admin user");
    await admin
      .get(`/api/audit/conversations/${created.body.conversation.id}/messages`)
      .expect(200)
      .expect(({ body }) => expect(body.items).toHaveLength(2));

    const auditPermission = await database.db
      .select({ id: permissions.id })
      .from(permissions)
      .where(and(eq(permissions.resource, "conversations"), eq(permissions.action, "audit")))
      .limit(1);
    const contentPermission = await database.db
      .select({ id: permissions.id })
      .from(permissions)
      .where(
        and(
          eq(permissions.resource, "conversations"),
          eq(permissions.action, "read-content"),
        ),
      )
      .limit(1);
    const adminActor = await database.db
      .select({ id: users.subjectId })
      .from(users)
      .where(eq(users.username, "admin"))
      .limit(1);
    const usersService = app.get(UsersService);
    const auditOnlyUser = await usersService.create(
      {
        username: "conversation-audit-only",
        password: "conversation-audit-only-password",
        displayName: "Conversation Audit Only",
      },
      { actorSubjectId: adminActor[0]!.id, ipAddress: null, userAgent: null },
    );
    const contentOnlyUser = await usersService.create(
      {
        username: "conversation-content-only",
        password: "conversation-content-only-password",
        displayName: "Conversation Content Only",
      },
      { actorSubjectId: adminActor[0]!.id, ipAddress: null, userAgent: null },
    );
    await database.db.insert(subjectPermissions).values([
      { subjectId: auditOnlyUser.id, permissionId: auditPermission[0]!.id },
      { subjectId: contentOnlyUser.id, permissionId: contentPermission[0]!.id },
    ]);

    const auditOnly = request.agent(app.getHttpServer());
    await auditOnly
      .post("/api/auth/login")
      .set("x-forwarded-for", "198.51.100.70")
      .set("origin", "http://localhost:3100")
      .send({ username: "conversation-audit-only", password: "conversation-audit-only-password" })
      .expect(200);
    await auditOnly.get(`/api/audit/conversations/${created.body.conversation.id}`).expect(200);
    await auditOnly
      .get(`/api/audit/conversations/${created.body.conversation.id}/messages`)
      .expect(403);

    const contentOnly = request.agent(app.getHttpServer());
    await contentOnly
      .post("/api/auth/login")
      .set("x-forwarded-for", "198.51.100.71")
      .set("origin", "http://localhost:3100")
      .send({
        username: "conversation-content-only",
        password: "conversation-content-only-password",
      })
      .expect(200);
    await contentOnly.get(`/api/audit/conversations/${created.body.conversation.id}`).expect(403);
    await contentOnly
      .get(`/api/audit/conversations/${created.body.conversation.id}/messages`)
      .expect(403);

    await admin
      .delete(`/api/conversations/${created.body.conversation.id}`)
      .set("origin", "http://localhost:3100")
      .expect(204);
    await admin.get(`/api/conversations/${created.body.conversation.id}`).expect(404);
    await admin.get(`/api/audit/conversations/${created.body.conversation.id}`).expect(200);

    const [auditRows, outboxRows] = await Promise.all([
      database.db.select({ metadata: auditLogs.metadata }).from(auditLogs),
      database.db.select({ payload: outboxEvents.payload }).from(outboxEvents),
    ]);
    expect(JSON.stringify(auditRows)).not.toContain("Find the admin user");
    expect(JSON.stringify(auditRows)).not.toContain("integration-sentinel-api-key");
    expect(JSON.stringify(outboxRows)).not.toContain("integration-sentinel-api-key");
    expect(JSON.stringify(outboxRows)).not.toContain("127.0.0.1");
  });

  it("manages agents with atomic assignments, live capabilities, and audited authorization", async () => {
    const admin = request.agent(app.getHttpServer());
    await admin
      .post("/api/auth/login")
      .set("x-forwarded-for", "203.0.113.10")
      .set("origin", "http://localhost:3100")
      .send({ username: "admin", password: "correct-horse-battery-staple" })
      .expect(200);

    const permissionCatalog = await admin.get("/api/permissions").expect(200);
    expect(permissionCatalog.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "agents:read" }),
        expect.objectContaining({ key: "agents:assign-permissions" }),
        expect.objectContaining({ key: "users:read" }),
      ]),
    );
    const usersReadPermission = permissionCatalog.body.find(
      (permission: { key: string }) => permission.key === "users:read",
    ) as { id: string };
    const agentsCreatePermission = permissionCatalog.body.find(
      (permission: { key: string }) => permission.key === "agents:create",
    ) as { id: string };

    const creatorUser = await admin
      .post("/api/users")
      .set("origin", "http://localhost:3100")
      .send({
        username: "agent-creator",
        password: "agent-creator-password",
        displayName: "Agent Creator",
      })
      .expect(201);
    await database.db.insert(subjectPermissions).values({
      subjectId: creatorUser.body.id as string,
      permissionId: agentsCreatePermission.id,
    });
    const creator = request.agent(app.getHttpServer());
    await creator
      .post("/api/auth/login")
      .set("x-forwarded-for", "203.0.113.11")
      .set("origin", "http://localhost:3100")
      .send({ username: "agent-creator", password: "agent-creator-password" })
      .expect(200);
    await creator.get("/api/agents").expect(403);
    await creator.get("/api/permissions").expect(403);
    await creator
      .post("/api/agents")
      .set("origin", "http://localhost:3100")
      .send({ slug: "blank-agent", name: "Blank Agent" })
      .expect(201);

    const beforeDeniedCreate = await database.db.select({ value: count() }).from(subjects);
    await creator
      .post("/api/agents")
      .set("origin", "http://localhost:3100")
      .send({
        slug: "privilege-escalation-agent",
        name: "Privilege Escalation Agent",
        permissionIds: [usersReadPermission.id],
      })
      .expect(403);
    const afterDeniedCreate = await database.db.select({ value: count() }).from(subjects);
    expect(afterDeniedCreate[0]?.value).toBe(beforeDeniedCreate[0]?.value);

    const invalidAssignmentId = "019d2f5b-a8ab-7000-8000-000000000099";
    const beforeInvalidAssignment = await database.db.select({ value: count() }).from(subjects);
    await admin
      .post("/api/agents")
      .set("origin", "http://localhost:3100")
      .send({
        slug: "invalid-role-agent",
        name: "Invalid Role Agent",
        roleIds: [invalidAssignmentId],
      })
      .expect(400);
    const afterInvalidAssignment = await database.db.select({ value: count() }).from(subjects);
    expect(afterInvalidAssignment[0]?.value).toBe(beforeInvalidAssignment[0]?.value);

    const created = await admin
      .post("/api/agents")
      .set("origin", "http://localhost:3100")
      .send({
        slug: "directory-agent",
        name: "Directory Agent",
        description: "Searches the internal user directory.",
        permissionIds: [usersReadPermission.id],
      })
      .expect(201);
    expect(created.body).toMatchObject({
      slug: "directory-agent",
      name: "Directory Agent",
      status: "active",
      roles: [],
      directPermissions: [expect.objectContaining({ key: "users:read" })],
      effectivePermissions: ["users:read"],
    });

    const beforeDuplicate = await database.db.select({ value: count() }).from(subjects);
    await admin
      .post("/api/agents")
      .set("origin", "http://localhost:3100")
      .send({ slug: "directory-agent", name: "Duplicate Directory Agent" })
      .expect(409);
    const afterDuplicate = await database.db.select({ value: count() }).from(subjects);
    expect(afterDuplicate[0]?.value).toBe(beforeDuplicate[0]?.value);
    const listed = await admin.get("/api/agents?search=directory&status=active").expect(200);
    expect(listed.body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(listed.body.items[0]).toMatchObject({ id: created.body.id, slug: "directory-agent" });

    await admin
      .put(`/api/agents/${created.body.id}`)
      .set("origin", "http://localhost:3100")
      .send({
        name: "Should Roll Back",
        description: "This update must not persist.",
        status: "disabled",
        roleIds: [],
        permissionIds: [invalidAssignmentId],
      })
      .expect(400);
    await admin.get(`/api/agents/${created.body.id}`).expect(200).expect(({ body }) => {
      expect(body).toMatchObject({
        name: "Directory Agent",
        status: "active",
        effectivePermissions: ["users:read"],
      });
    });

    await admin
      .get(`/api/agents/${created.body.id}/capabilities`)
      .expect(200)
      .expect(({ body }) => {
        expect(body).toEqual([expect.objectContaining({ id: "users.search" })]);
      });
    await admin
      .put(`/api/agents/${created.body.id}`)
      .set("origin", "http://localhost:3100")
      .send({
        name: "Directory Agent (paused)",
        description: "Temporarily disabled.",
        status: "disabled",
      })
      .expect(200);
    await admin.get(`/api/agents/${created.body.id}/capabilities`).expect(200, []);

    await admin
      .put(`/api/agents/${created.body.id}`)
      .set("origin", "http://localhost:3100")
      .send({
        name: "Directory Agent",
        description: "Searches the internal user directory.",
        status: "active",
      })
      .expect(200);
    await admin
      .get(`/api/agents/${created.body.id}/capabilities`)
      .expect(200)
      .expect(({ body }) => expect(body).toHaveLength(1));
    await admin
      .put(`/api/agents/${created.body.id}/permissions`)
      .set("origin", "http://localhost:3100")
      .send({ permissionIds: [] })
      .expect(204);
    await admin.get(`/api/agents/${created.body.id}/capabilities`).expect(200, []);
    await admin
      .put(`/api/agents/${created.body.id}/permissions`)
      .set("origin", "http://localhost:3100")
      .send({ permissionIds: [usersReadPermission.id] })
      .expect(204);
    await admin
      .get(`/api/agents/${created.body.id}/capabilities`)
      .expect(200)
      .expect(({ body }) => expect(body).toHaveLength(1));

    const roleList = await admin.get("/api/roles").expect(200);
    const superAdminRole = roleList.body.find(
      (role: { key: string }) => role.key === "super-admin",
    ) as { id: string };
    await admin
      .put(`/api/agents/${created.body.id}/roles`)
      .set("origin", "http://localhost:3100")
      .send({ roleIds: [superAdminRole.id] })
      .expect(204);
    await admin.get(`/api/agents/${created.body.id}`).expect(200).expect(({ body }) => {
      expect(body.roles).toEqual([expect.objectContaining({ key: "super-admin" })]);
      expect(body.effectivePermissions).toContain("agents:update");
    });

    const agentAudits = await database.db
      .select({ action: auditLogs.action, resourceId: auditLogs.resourceId, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.resourceType, "agent"));
    expect(agentAudits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "agent.created", resourceId: created.body.id }),
        expect.objectContaining({ action: "agent.updated", resourceId: created.body.id }),
        expect.objectContaining({ action: "agent.permissions.updated", resourceId: created.body.id }),
        expect.objectContaining({ action: "agent.roles.updated", resourceId: created.body.id }),
        expect.objectContaining({
          action: "authorization.denied",
          resourceId: "privilege-escalation-agent",
          metadata: { requiredPermissions: ["agents:assign-permissions"] },
        }),
      ]),
    );
    expect(JSON.stringify(agentAudits)).not.toContain("agent-creator-password");
  });

  it("enforces organization constraints, transaction rollback, and direct grants", async () => {
    const root = await database.db
      .insert(departments)
      .values({ code: "operations", name: "Operations" })
      .returning({ id: departments.id });
    const child = await database.db
      .insert(departments)
      .values({ code: "operations-platform", name: "Platform", parentId: root[0]!.id })
      .returning({ parentId: departments.parentId });
    expect(child[0]?.parentId).toBe(root[0]!.id);
    await expect(
      database.db.insert(departments).values({ code: "operations", name: "Duplicate" }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    const before = await database.db.select({ value: count() }).from(subjects);
    const usersService = app.get(UsersService);
    await expect(
      usersService.create(
        {
          username: "invalid-department-user",
          password: "invalid-department-password",
          displayName: "Invalid Department",
          departmentId: "00000000-0000-0000-0000-000000000000",
        },
        { actorSubjectId: root[0]!.id, ipAddress: null, userAgent: null },
      ),
    ).rejects.toThrow("Invalid department");
    const after = await database.db.select({ value: count() }).from(subjects);
    expect(after[0]?.value).toBe(before[0]?.value);

    const directSubject = await database.db
      .insert(subjects)
      .values({ type: "agent" })
      .returning({ id: subjects.id });
    await database.db.insert(agents).values({
      subjectId: directSubject[0]!.id,
      slug: "direct-grant-agent",
      name: "Direct Grant Agent",
    });
    const permission = await database.db
      .select({ id: permissions.id })
      .from(permissions)
      .where(eq(permissions.resource, "users"))
      .limit(1);
    await database.db.insert(subjectPermissions).values({
      subjectId: directSubject[0]!.id,
      permissionId: permission[0]!.id,
    });
    const authorization = app.get(AuthorizationService);
    expect((await authorization.getEffectivePermissions(directSubject[0]!.id)).length).toBe(1);
  });

  it("evaluates explicit Agent grants as OR and traverses only active, cycle-safe departments", async () => {
    const root = await database.db
      .insert(departments)
      .values({ code: "grant-root", name: "Grant Root" })
      .returning({ id: departments.id });
    const middle = await database.db
      .insert(departments)
      .values({ code: "grant-middle", name: "Grant Middle", parentId: root[0]!.id })
      .returning({ id: departments.id });
    const leaf = await database.db
      .insert(departments)
      .values({ code: "grant-leaf", name: "Grant Leaf", parentId: middle[0]!.id })
      .returning({ id: departments.id });

    const actorSubject = await database.db
      .insert(subjects)
      .values({ type: "user" })
      .returning({ id: subjects.id });
    await database.db.insert(users).values({
      subjectId: actorSubject[0]!.id,
      departmentId: leaf[0]!.id,
      username: "agent-access-actor",
      passwordHash: "integration-only-password-hash",
      displayName: "Agent Access Actor",
    });
    const superAdminRole = await database.db
      .select({ id: roles.subjectId })
      .from(roles)
      .where(eq(roles.key, "super-admin"))
      .limit(1);
    await database.db.insert(subjectRoles).values({
      subjectId: actorSubject[0]!.id,
      roleId: superAdminRole[0]!.id,
    });

    const governedAgent = await database.db
      .insert(subjects)
      .values({ type: "agent" })
      .returning({ id: subjects.id });
    await database.db.insert(agents).values({
      subjectId: governedAgent[0]!.id,
      slug: "explicit-access-agent",
      name: "Explicit Access Agent",
    });
    const defaultModel = await database.db
      .select({ id: modelProfiles.id })
      .from(modelProfiles)
      .where(eq(modelProfiles.key, "default"))
      .limit(1);
    await database.db.insert(agentRuntimes).values({
      agentSubjectId: governedAgent[0]!.id,
      modelProfileId: defaultModel[0]!.id,
      systemPrompt: "Integration access test.",
    });

    const access = app.get(AgentAccessService);
    await expect(access.canInvoke(actorSubject[0]!.id, governedAgent[0]!.id)).resolves.toBe(false);
    await expect(access.listAvailable(actorSubject[0]!.id)).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: governedAgent[0]!.id })]),
    );

    await database.db.insert(agentUserAccessGrants).values({
      agentSubjectId: governedAgent[0]!.id,
      userSubjectId: actorSubject[0]!.id,
    });
    await expect(access.canInvoke(actorSubject[0]!.id, governedAgent[0]!.id)).resolves.toBe(true);
    await database.db
      .delete(agentUserAccessGrants)
      .where(
        and(
          eq(agentUserAccessGrants.agentSubjectId, governedAgent[0]!.id),
          eq(agentUserAccessGrants.userSubjectId, actorSubject[0]!.id),
        ),
      );

    await database.db.insert(agentRoleAccessGrants).values({
      agentSubjectId: governedAgent[0]!.id,
      roleSubjectId: superAdminRole[0]!.id,
    });
    await expect(access.canInvoke(actorSubject[0]!.id, governedAgent[0]!.id)).resolves.toBe(true);
    await database.db
      .delete(agentRoleAccessGrants)
      .where(
        and(
          eq(agentRoleAccessGrants.agentSubjectId, governedAgent[0]!.id),
          eq(agentRoleAccessGrants.roleSubjectId, superAdminRole[0]!.id),
        ),
      );

    await database.db.insert(agentDepartmentAccessGrants).values({
      agentSubjectId: governedAgent[0]!.id,
      departmentId: root[0]!.id,
      includeDescendants: false,
    });
    await expect(access.canInvoke(actorSubject[0]!.id, governedAgent[0]!.id)).resolves.toBe(false);
    await database.db
      .update(agentDepartmentAccessGrants)
      .set({ includeDescendants: true })
      .where(
        and(
          eq(agentDepartmentAccessGrants.agentSubjectId, governedAgent[0]!.id),
          eq(agentDepartmentAccessGrants.departmentId, root[0]!.id),
        ),
      );
    await expect(access.canInvoke(actorSubject[0]!.id, governedAgent[0]!.id)).resolves.toBe(true);

    await database.db
      .update(departments)
      .set({ parentId: leaf[0]!.id })
      .where(eq(departments.id, root[0]!.id));
    await expect(access.canInvoke(actorSubject[0]!.id, governedAgent[0]!.id)).resolves.toBe(true);
    await expect(access.listAvailable(actorSubject[0]!.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: governedAgent[0]!.id })]),
    );

    await database.db
      .update(departments)
      .set({ status: "disabled" })
      .where(eq(departments.id, middle[0]!.id));
    await expect(access.canInvoke(actorSubject[0]!.id, governedAgent[0]!.id)).resolves.toBe(false);

    await database.db.insert(agentUserAccessGrants).values({
      agentSubjectId: governedAgent[0]!.id,
      userSubjectId: actorSubject[0]!.id,
    });
    await expect(access.canInvoke(actorSubject[0]!.id, governedAgent[0]!.id)).resolves.toBe(true);
  });

  it("invalidates expired and disabled sessions immediately", async () => {
    const client = request.agent(app.getHttpServer());
    const login = await client
      .post("/api/auth/login")
      .set("x-forwarded-for", "198.51.100.46")
      .set("origin", "http://localhost:3100")
      .send({ username: "admin", password: "correct-horse-battery-staple" })
      .expect(200);
    expect(login.body.user.username).toBe("admin");

    const adminUser = await database.db
      .select({ id: users.subjectId })
      .from(users)
      .where(eq(users.username, "admin"))
      .limit(1);
    await database.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(sessions.userSubjectId, adminUser[0]!.id));
    await client.get("/api/auth/me").expect(401);

    const secondClient = request.agent(app.getHttpServer());
    await secondClient
      .post("/api/auth/login")
      .set("x-forwarded-for", "198.51.100.47")
      .set("origin", "http://localhost:3100")
      .send({ username: "admin", password: "correct-horse-battery-staple" })
      .expect(200);
    await database.db.update(subjects).set({ status: "disabled" }).where(eq(subjects.id, adminUser[0]!.id));
    await secondClient.get("/api/auth/me").expect(401);
    await database.db.update(subjects).set({ status: "active" }).where(eq(subjects.id, adminUser[0]!.id));
  });

  it("rate limits repeated login attempts", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await request(app.getHttpServer())
        .post("/api/auth/login")
        .set("x-forwarded-for", "198.51.100.250")
        .set("origin", "http://localhost:3100")
        .send({ username: "missing", password: "incorrect-password" });
      statuses.push(response.status);
      if (response.status === 429) break;
    }
    expect(statuses).toContain(429);
  });

  it("syncs an MCP server, governs its tools, and executes a bound tool through the capability bridge", async () => {
    const mcpCalls: Array<{ workspace: unknown; authorization: string | undefined }> = [];
    const mcpHttp = createServer(async (incoming, response) => {
      const authorization = incoming.headers.authorization;
      if (authorization !== process.env.MCP_E2E_TOKEN) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let rawBody = "";
      for await (const chunk of incoming) rawBody += String(chunk);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      const mcp = new McpServer({ name: "integration-mcp", version: "1.0.0" });
      mcp.registerTool(
        "get_workspace_info",
        {
          description: "Describe an AgentMix workspace.",
          inputSchema: { workspace: z.string() },
        },
        async ({ workspace }) => {
          mcpCalls.push({ workspace, authorization });
          return {
            content: [{ type: "text", text: `Workspace ${workspace} has 3 members.` }],
            structuredContent: { workspace, members: 3, plan: "enterprise" },
          };
        },
      );
      await mcp.connect(transport);
      response.on("close", () => {
        void mcp.close();
        void transport.close();
      });
      await transport.handleRequest(incoming, response, rawBody ? JSON.parse(rawBody) : undefined);
    });
    await new Promise<void>((resolve) => mcpHttp.listen(0, "127.0.0.1", resolve));
    const mcpAddress = mcpHttp.address() as AddressInfo;

    const admin = request.agent(app.getHttpServer());
    await admin
      .post("/api/auth/login")
      .set("x-forwarded-for", "198.51.100.80")
      .set("origin", "http://localhost:3100")
      .send({ username: "admin", password: "correct-horse-battery-staple" })
      .expect(200);

    try {
      const serverCreated = await admin
        .post("/api/mcp/servers")
        .set("origin", "http://localhost:3100")
        .send({
          slug: "integration-mcp",
          name: "Integration MCP",
          description: "E2E MCP tool server",
          endpointUrl: `http://127.0.0.1:${mcpAddress.port}/mcp`,
          authHeaderName: "Authorization",
          authEnvVar: "MCP_E2E_TOKEN",
          status: "active",
        })
        .expect(201);
      expect(serverCreated.body).toMatchObject({
        slug: "integration-mcp",
        hasAuth: true,
        authEnvVar: "MCP_E2E_TOKEN",
        toolCount: 0,
      });

      // A partial update that omits the credential pair must preserve it: the
      // admin form never round-trips the pair, so dropping it here would make
      // every rename silently de-authenticate the server.
      const renamed = await admin
        .put(`/api/mcp/servers/${serverCreated.body.id}`)
        .set("origin", "http://localhost:3100")
        .send({ name: "Integration MCP renamed" })
        .expect(200);
      expect(renamed.body).toMatchObject({
        name: "Integration MCP renamed",
        hasAuth: true,
        authEnvVar: "MCP_E2E_TOKEN",
      });
      // Null is refused instead of being treated as "clear".
      await admin
        .put(`/api/mcp/servers/${serverCreated.body.id}`)
        .set("origin", "http://localhost:3100")
        .send({ authHeaderName: null, authEnvVar: null })
        .expect(400);
      // Half a pair is refused too.
      await admin
        .put(`/api/mcp/servers/${serverCreated.body.id}`)
        .set("origin", "http://localhost:3100")
        .send({ authEnvVar: "MCP_OTHER_TOKEN" })
        .expect(400);
      // Replacing the pair keeps the server usable.
      const rotated = await admin
        .put(`/api/mcp/servers/${serverCreated.body.id}`)
        .set("origin", "http://localhost:3100")
        .send({ authHeaderName: "Authorization", authEnvVar: "MCP_E2E_TOKEN" })
        .expect(200);
      expect(rotated.body).toMatchObject({ hasAuth: true, authEnvVar: "MCP_E2E_TOKEN" });

      await admin
        .post("/api/mcp/servers")
        .set("origin", "http://localhost:3100")
        .send({
          slug: "integration-mcp",
          name: "Integration MCP duplicate",
          endpointUrl: `http://127.0.0.1:${mcpAddress.port}/mcp`,
        })
        .expect(409);

      const sync = await admin
        .post(`/api/mcp/servers/${serverCreated.body.id}/sync`)
        .set("origin", "http://localhost:3100")
        .expect(200);
      expect(sync.body).toMatchObject({ added: 1, updated: 0, removed: [] });
      expect(sync.body.removed).toEqual([]);

      const serverAfterSync = await admin.get("/api/mcp/servers").expect(200);
      const serverRow = serverAfterSync.body.items.find(
        (item: { id: string }) => item.id === serverCreated.body.id,
      );
      expect(serverRow.lastSyncedAt).toBeTruthy();
      expect(serverRow.lastSyncErrorCode).toBeNull();

      const toolList = await admin
        .get(`/api/mcp/servers/${serverCreated.body.id}/tools`)
        .expect(200);
      const tool = toolList.body.items.find((item: { name: string }) => item.name === "get_workspace_info");
      expect(tool).toMatchObject({ enabled: false, risk: "read", requiredPermissions: [] });

      await admin
        .put(`/api/mcp/tools/${tool.id}`)
        .set("origin", "http://localhost:3100")
        .send({ enabled: true })
        .expect(409);
      await admin
        .put(`/api/mcp/tools/${tool.id}`)
        .set("origin", "http://localhost:3100")
        .send({ requiredPermissions: ["definitely:not-a-permission"], enabled: true })
        .expect(409);
      await admin
        .put(`/api/mcp/tools/${tool.id}`)
        .set("origin", "http://localhost:3100")
        .send({ requiredPermissions: ["users:read"], risk: "read", enabled: true })
        .expect(200);

      const available = await admin.get("/api/chat/agents").expect(200);
      const assistant = available.body.items.find(
        (agent: { slug: string }) => agent.slug === "agentmix-assistant",
      ) as { id: string };

      await admin
        .put(`/api/agents/${assistant.id}/tools`)
        .set("origin", "http://localhost:3100")
        .send({ toolIds: [randomUUID()] })
        .expect(400);
      await admin
        .put(`/api/agents/${assistant.id}/tools`)
        .set("origin", "http://localhost:3100")
        .send({ toolIds: [tool.id] })
        .expect(204);

      // The model sees the provider-safe derivative of the capability id, not
      // the bare remote tool name.
      providerToolCallOverride = {
        name: deriveProviderToolName("mcp-integration-mcp.get_workspace_info"),
        argsJson: '{"workspace":"acme"}',
      };
      const created = await admin
        .post("/api/conversations")
        .set("origin", "http://localhost:3100")
        .set("idempotency-key", randomUUID())
        .send({ agentId: assistant.id, content: "Describe the acme workspace." })
        .expect(202);

      let run = created.body.run;
      for (let index = 0; index < 200 && !["completed", "failed", "canceled"].includes(run.status); index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        run = (await admin.get(`/api/runs/${run.id}`).expect(200)).body;
      }
      expect(run).toMatchObject({
        status: "completed",
        assistantMessage: { content: "Found the governed administrator account." },
      });

      expect(mcpCalls).toHaveLength(1);
      expect(mcpCalls[0]).toMatchObject({
        workspace: "acme",
        authorization: process.env.MCP_E2E_TOKEN,
      });

      const executedAudit = await database.db
        .select({ resourceId: auditLogs.resourceId, metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(eq(auditLogs.action, "capability.executed"))
        .orderBy(auditLogs.createdAt)
        .limit(50);
      const mcpAudit = executedAudit.find((row) => row.resourceId === "mcp-integration-mcp.get_workspace_info");
      expect(mcpAudit).toBeTruthy();
      expect(mcpAudit?.metadata).toMatchObject({ risk: "read", capabilityVersion: "1.0.0" });

      // Revoking the agent's required permission mid-run must turn the next
      // MCP tool invocation into a governed capability failure.
      await admin
        .put(`/api/mcp/tools/${tool.id}`)
        .set("origin", "http://localhost:3100")
        .send({ enabled: true })
        .expect(200);
      const usersReadPermission = await database.db
        .select({ id: permissions.id })
        .from(permissions)
        .where(and(eq(permissions.resource, "users"), eq(permissions.action, "read")))
        .limit(1);
      const revocationGate = createCapabilityGate();
      capabilityGate = revocationGate;
      let permissionRevoked = false;
      try {
        const revokedRequest = await admin
          .post("/api/conversations")
          .set("origin", "http://localhost:3100")
          .set("idempotency-key", randomUUID())
          .send({ agentId: assistant.id, content: "CAPABILITY_REVOCATION_PROBE" })
          .expect(202);
        await Promise.race([
          revocationGate.reached,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("MCP revocation probe did not reach the model")), 5_000),
          ),
        ]);
        await database.db
          .delete(subjectPermissions)
          .where(
            and(
              eq(subjectPermissions.subjectId, assistant.id),
              eq(subjectPermissions.permissionId, usersReadPermission[0]!.id),
            ),
          );
        permissionRevoked = true;
        revocationGate.allow();

        let revokedRun = revokedRequest.body.run;
        for (
          let index = 0;
          index < 200 && !["completed", "failed", "canceled"].includes(revokedRun.status);
          index += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          revokedRun = (await admin.get(`/api/runs/${revokedRun.id}`).expect(200)).body;
        }
        expect(revokedRun).toMatchObject({ status: "failed", errorCode: "capability_failed" });
        expect(mcpCalls).toHaveLength(1);
      } finally {
        revocationGate.allow();
        capabilityGate = null;
        if (permissionRevoked) {
          await database.db
            .insert(subjectPermissions)
            .values({ subjectId: assistant.id, permissionId: usersReadPermission[0]!.id })
            .onConflictDoNothing();
        }
      }

      // clearAuth is the only way to remove the pair, and it takes effect.
      const cleared = await admin
        .put(`/api/mcp/servers/${serverCreated.body.id}`)
        .set("origin", "http://localhost:3100")
        .send({ clearAuth: true })
        .expect(200);
      expect(cleared.body).toMatchObject({ hasAuth: false, authEnvVar: null });
      await admin
        .put(`/api/mcp/servers/${serverCreated.body.id}`)
        .set("origin", "http://localhost:3100")
        .send({ clearAuth: true })
        .expect(400);
      // Without credentials the server now rejects the sync; it fails closed
      // with a stable safe code rather than leaking the remote response.
      const unauthenticatedSync = await admin
        .post(`/api/mcp/servers/${serverCreated.body.id}/sync`)
        .set("origin", "http://localhost:3100")
        .expect(502);
      expect(unauthenticatedSync.body.message).toMatch(
        /^MCP tool sync failed \((?:CONNECT_FAILED|PROTOCOL_ERROR|TIMEOUT)\)$/,
      );
      expect(JSON.stringify(unauthenticatedSync.body)).not.toContain(process.env.MCP_E2E_TOKEN!);
    } catch (testError) {
      console.log("MCP-TEST-ERROR", testError);
      throw testError;
    } finally {
      providerToolCallOverride = null;
      // Keep-alive sockets (and the MCP standby stream) would otherwise keep
      // close()'s callback pending and swallow the real failure above.
      mcpHttp.closeAllConnections();
      await new Promise<void>((resolve) => mcpHttp.close(() => resolve()));
    }
  });
});
