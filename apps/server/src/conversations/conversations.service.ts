import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_RUN_CANCEL_OUTBOX_TOPIC,
  AGENT_RUN_MAX_TOOLS,
  AgentRunEventV1Schema,
  AgentRunControlV1Schema,
  AgentRunTaskV1Schema,
  type AgentRunTaskV1,
  deriveProviderToolName,
  type CapabilityDescriptor,
  type RuntimeToolDescriptorV1,
} from "@agentmix/core";
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, desc, eq, inArray, isNull, max, or, sql } from "drizzle-orm";
import type { Response } from "express";
import { AgentAccessService } from "../agents/agent-access.service";
import { AuditService } from "../audit/audit.service";
import { CapabilityExecutor } from "../capabilities/capability.executor";
import { DatabaseService } from "../database/database.service";
import {
  agentRunEvents,
  agentRuns,
  agentRuntimes,
  agentToolBindings,
  agents,
  conversationMessages,
  conversations,
  mcpServers,
  mcpTools,
  modelProfiles,
  outboxEvents,
  subjects,
} from "../database/schema";
import { buildUsersSearchToolDescriptor, USERS_SEARCH_TOOL_ID } from "../capabilities/tool-descriptors";
import { deriveMcpCapabilityId, MCP_MODULE_PREFIX } from "../mcp/mcp.tooling";
import { RuntimeService } from "../runtime/runtime.service";

interface ActorMetadata {
  actorSubjectId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

type RuntimeSnapshot = {
  agent: { id: string; slug: string; name: string; description: string };
  profile: { id: string; key: string; modelId: string };
  systemPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  maxSteps: number;
  capabilities: string[];
  tools: RuntimeToolDescriptorV1[];
};

const ACTIVE_STATUSES = ["queued", "running"] as const;
const TERMINAL_STATUSES = ["completed", "failed", "canceled"] as const;
const SSE_EVENT_BATCH_SIZE = 200;
// Per-connection database polling cadence. Latency-sensitive delivery on top
// of this projection should arrive via a push channel, not a shorter interval.
const SSE_POLL_INTERVAL_MS = 250;

type DatabaseTransaction = Parameters<Parameters<DatabaseService["db"]["transaction"]>[0]>[0];

function hashRequest(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new ConflictException("A UUID Idempotency-Key header is required");
  }
  return value.toLowerCase();
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "23505") return true;
  return "cause" in error && isUniqueViolation(error.cause);
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly access: AgentAccessService,
    private readonly capabilities: CapabilityExecutor,
    private readonly runtime: RuntimeService,
    private readonly audit: AuditService,
  ) {}

  async listInvokableAgents(userSubjectId: string) {
    return { items: await this.access.listAvailable(userSubjectId) };
  }

  async create(
    agentId: string,
    content: string,
    idempotencyHeader: string | undefined,
    actor: ActorMetadata,
  ) {
    const idempotencyKey = normalizeIdempotencyKey(idempotencyHeader);
    const requestHash = hashRequest({ operation: "conversation.create", agentId, content });
    const existing = await this.findIdempotentRun(actor.actorSubjectId, idempotencyKey);
    if (existing) return this.resolveIdempotent(existing, requestHash);

    const snapshot = await this.resolveRuntimeSnapshot(actor.actorSubjectId, agentId);
    const now = new Date();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const runId = randomUUID();
    const task = this.buildTask({
      runId,
      conversationId,
      actorSubjectId: actor.actorSubjectId,
      snapshot,
      messages: [{ id: messageId, role: "user", content }],
      now,
    });
    try {
      await this.database.db.transaction(async (tx) => {
        await tx.insert(conversations).values({
          id: conversationId,
          userSubjectId: actor.actorSubjectId,
          agentSubjectId: agentId,
          title: content.replace(/\s+/g, " ").slice(0, 80),
          lastMessageAt: now,
        });
        await tx.insert(conversationMessages).values({
          id: messageId,
          conversationId,
          role: "user",
          content,
          createdAt: now,
        });
        await tx.insert(agentRuns).values({
          id: runId,
          conversationId,
          requestedBySubjectId: actor.actorSubjectId,
          agentSubjectId: agentId,
          modelProfileId: snapshot.profile.id,
          userMessageId: messageId,
          idempotencyKey,
          requestHash,
          executionSnapshot: task,
          queuedAt: now,
        });
        await tx.insert(outboxEvents).values({
          runId,
          modelCheckId: null,
          topic: "agent.run.requested",
          deduplicationKey: runId,
          payload: task,
        });
        await this.audit.record(
          {
            ...actor,
            action: "conversation.run.requested",
            resourceType: "conversation_run",
            resourceId: runId,
            outcome: "success",
            metadata: {
              conversationId,
              agentSubjectId: agentId,
              modelProfileId: snapshot.profile.id,
              status: "queued",
            },
          },
          tx,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await this.findIdempotentRun(actor.actorSubjectId, idempotencyKey);
        if (raced) return this.resolveIdempotent(raced, requestHash);
      }
      throw error;
    }
    return this.getCreateResponse(conversationId, runId, actor.actorSubjectId);
  }

  async addMessage(
    conversationId: string,
    content: string,
    idempotencyHeader: string | undefined,
    actor: ActorMetadata,
  ) {
    const idempotencyKey = normalizeIdempotencyKey(idempotencyHeader);
    const requestHash = hashRequest({ operation: "conversation.message", conversationId, content });
    const existing = await this.findIdempotentRun(actor.actorSubjectId, idempotencyKey);
    if (existing) {
      const resolved = await this.resolveIdempotent(existing, requestHash);
      return { run: resolved.run };
    }
    const conversation = await this.getOwnedConversation(conversationId, actor.actorSubjectId);
    const snapshot = await this.resolveRuntimeSnapshot(
      actor.actorSubjectId,
      conversation.agentSubjectId,
    );
    const now = new Date();
    const messageId = randomUUID();
    const runId = randomUUID();
    try {
      await this.database.db.transaction(async (tx) => {
        const lockedConversation = await this.getOwnedConversationForUpdate(
          tx,
          conversationId,
          actor.actorSubjectId,
        );
        const concurrent = await tx
          .select({ id: agentRuns.id })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.conversationId, conversationId),
              inArray(agentRuns.status, [...ACTIVE_STATUSES]),
            ),
          )
          .limit(1);
        if (concurrent[0]) throw new ConflictException("A run is already active for this conversation");
        const history = await tx
          .select({
            id: conversationMessages.id,
            role: conversationMessages.role,
            content: conversationMessages.content,
          })
          .from(agentRuns)
          .innerJoin(
            conversationMessages,
            or(
              eq(conversationMessages.id, agentRuns.userMessageId),
              eq(conversationMessages.id, agentRuns.assistantMessageId),
            ),
          )
          .where(
            and(eq(agentRuns.conversationId, conversationId), eq(agentRuns.status, "completed")),
          )
          .orderBy(asc(agentRuns.createdAt), asc(conversationMessages.createdAt));
        const task = this.buildTask({
          runId,
          conversationId,
          actorSubjectId: actor.actorSubjectId,
          snapshot,
          messages: [...history, { id: messageId, role: "user" as const, content }],
          now,
        });
        await tx.insert(conversationMessages).values({
          id: messageId,
          conversationId,
          role: "user",
          content,
          createdAt: now,
        });
        await tx.insert(agentRuns).values({
          id: runId,
          conversationId,
          requestedBySubjectId: actor.actorSubjectId,
          agentSubjectId: lockedConversation.agentSubjectId,
          modelProfileId: snapshot.profile.id,
          userMessageId: messageId,
          idempotencyKey,
          requestHash,
          executionSnapshot: task,
          queuedAt: now,
        });
        await tx.insert(outboxEvents).values({
          runId,
          modelCheckId: null,
          topic: "agent.run.requested",
          deduplicationKey: runId,
          payload: task,
        });
        await tx
          .update(conversations)
          .set({ lastMessageAt: now, updatedAt: now })
          .where(eq(conversations.id, conversationId));
        await this.audit.record(
          {
            ...actor,
            action: "conversation.run.requested",
            resourceType: "conversation_run",
            resourceId: runId,
            outcome: "success",
            metadata: {
              conversationId,
              agentSubjectId: lockedConversation.agentSubjectId,
              modelProfileId: snapshot.profile.id,
              status: "queued",
            },
          },
          tx,
        );
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await this.findIdempotentRun(actor.actorSubjectId, idempotencyKey);
        if (raced) {
          const resolved = await this.resolveIdempotent(raced, requestHash);
          return { run: resolved.run };
        }
      }
      throw error;
    }
    return { run: await this.getRun(runId, actor.actorSubjectId) };
  }

  async list(userSubjectId: string, page: number, pageSize: number) {
    const where = and(eq(conversations.userSubjectId, userSubjectId), isNull(conversations.deletedAt));
    const [items, totals] = await Promise.all([
      this.database.db
        .select({
          id: conversations.id,
          title: conversations.title,
          agentId: agents.subjectId,
          agentSlug: agents.slug,
          agentName: agents.name,
          lastMessageAt: conversations.lastMessageAt,
          createdAt: conversations.createdAt,
          updatedAt: conversations.updatedAt,
        })
        .from(conversations)
        .innerJoin(agents, eq(conversations.agentSubjectId, agents.subjectId))
        .where(where)
        .orderBy(desc(conversations.lastMessageAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.database.db.select({ value: count() }).from(conversations).where(where),
    ]);
    return {
      items: items.map((item) => ({
        id: item.id,
        title: item.title,
        agent: { id: item.agentId, slug: item.agentSlug, name: item.agentName },
        lastMessageAt: item.lastMessageAt.toISOString(),
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
      total: totals[0]?.value ?? 0,
      page,
      pageSize,
    };
  }

  async getDetail(conversationId: string, userSubjectId: string) {
    const conversation = await this.getOwnedConversation(conversationId, userSubjectId);
    const [messageRows, activeRows] = await Promise.all([
      this.database.db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId))
        .orderBy(asc(conversationMessages.createdAt)),
      this.database.db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.conversationId, conversationId),
            inArray(agentRuns.status, [...ACTIVE_STATUSES]),
          ),
        )
        .limit(1),
    ]);
    return {
      conversation: this.serializeConversation(conversation),
      messages: messageRows.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
      })),
      activeRun: activeRows[0] ? await this.getRun(activeRows[0].id, userSubjectId) : null,
    };
  }

  async softDelete(conversationId: string, actor: ActorMetadata): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      const conversation = await this.getOwnedConversationForUpdate(
        tx,
        conversationId,
        actor.actorSubjectId,
      );
      const active = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.conversationId, conversationId),
            inArray(agentRuns.status, [...ACTIVE_STATUSES]),
          ),
        )
        .limit(1);
      if (active[0]) {
        throw new ConflictException("Stop the active run before deleting the conversation");
      }
      const now = new Date();
      await tx
        .update(conversations)
        .set({ deletedAt: now, updatedAt: now })
        .where(eq(conversations.id, conversation.id));
      await this.audit.record(
        {
          ...actor,
          action: "conversation.deleted",
          resourceType: "conversation",
          resourceId: conversationId,
          outcome: "success",
          metadata: { agentSubjectId: conversation.agentSubjectId },
        },
        tx,
      );
    });
  }

  async getRun(runId: string, userSubjectId: string) {
    const rows = await this.database.db
      .select({
        id: agentRuns.id,
        conversationId: agentRuns.conversationId,
        status: agentRuns.status,
        attempt: agentRuns.attempt,
        usage: agentRuns.usage,
        finishReason: agentRuns.finishReason,
        errorCode: agentRuns.errorCode,
        queuedAt: agentRuns.queuedAt,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        createdAt: agentRuns.createdAt,
        updatedAt: agentRuns.updatedAt,
        assistantMessageId: conversationMessages.id,
        assistantContent: conversationMessages.content,
        assistantCreatedAt: conversationMessages.createdAt,
      })
      .from(agentRuns)
      .innerJoin(conversations, eq(agentRuns.conversationId, conversations.id))
      .leftJoin(conversationMessages, eq(agentRuns.assistantMessageId, conversationMessages.id))
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(conversations.userSubjectId, userSubjectId),
          isNull(conversations.deletedAt),
        ),
      )
      .limit(1);
    if (!rows[0]) throw new NotFoundException("Run not found");
    return this.serializeRun(rows[0]);
  }

  async cancel(runId: string, actor: ActorMetadata) {
    const rows = await this.database.db
      .select({
        status: agentRuns.status,
        conversationId: agentRuns.conversationId,
        attempt: agentRuns.attempt,
      })
      .from(agentRuns)
      .innerJoin(conversations, eq(agentRuns.conversationId, conversations.id))
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(conversations.userSubjectId, actor.actorSubjectId),
          isNull(conversations.deletedAt),
        ),
      )
      .limit(1);
    const run = rows[0];
    if (!run) throw new NotFoundException("Run not found");
    if ((TERMINAL_STATUSES as readonly string[]).includes(run.status)) {
      return this.getRun(runId, actor.actorSubjectId);
    }
    const now = new Date();
    const transition = await this.database.db.transaction(async (tx) => {
      await tx.execute(sql`select id from agent_runs where id = ${runId} for update`);
      const currentRows = await tx
        .select({ status: agentRuns.status, attempt: agentRuns.attempt })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      const current = currentRows[0];
      if (!current || (TERMINAL_STATUSES as readonly string[]).includes(current.status)) {
        return { requested: false, previousStatus: current?.status ?? run.status };
      }

      if (current.status === "queued") {
        const attempt = Math.max(1, current.attempt);
        const sequenceRows = await tx
          .select({ value: max(agentRunEvents.sequence) })
          .from(agentRunEvents)
          .where(and(eq(agentRunEvents.runId, runId), eq(agentRunEvents.attempt, attempt)));
        const event = AgentRunEventV1Schema.parse({
          version: 1,
          kind: "agent.run.event",
          eventId: randomUUID(),
          runId,
          conversationId: run.conversationId,
          attempt,
          sequence: (sequenceRows[0]?.value ?? 0) + 1,
          occurredAt: now.toISOString(),
          type: "run.cancelled",
          reason: "requested",
        });
        await tx
          .update(agentRuns)
          .set({
            status: "canceled",
            attempt,
            cancelRequestedAt: now,
            completedAt: now,
            errorCode: "cancelled",
            errorMessage: "Generation stopped",
            updatedAt: now,
          })
          .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "queued")));
        await tx
          .update(outboxEvents)
          .set({ status: "published", publishedAt: now, lastErrorCode: "CANCELED", updatedAt: now })
          .where(and(eq(outboxEvents.runId, runId), eq(outboxEvents.status, "pending")));
        await tx.insert(agentRunEvents).values({
          eventId: event.eventId,
          runId,
          sequence: event.sequence,
          attempt: event.attempt,
          type: event.type,
          payload: event as unknown as Record<string, unknown>,
          occurredAt: now,
        });
      } else {
        await tx
          .update(agentRuns)
          .set({ cancelRequestedAt: now, updatedAt: now })
          .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, "running")));
      }
      const control = AgentRunControlV1Schema.parse({
        version: 1,
        kind: "agent.run.cancel",
        runId,
        requestedAt: now.toISOString(),
      });
      await tx
        .insert(outboxEvents)
        .values({
          runId,
          modelCheckId: null,
          topic: AGENT_RUN_CANCEL_OUTBOX_TOPIC,
          deduplicationKey: `agent.run.cancel:${runId}`,
          payload: control as Record<string, unknown>,
        })
        .onConflictDoNothing({ target: outboxEvents.deduplicationKey });
      await this.audit.record(
        {
          ...actor,
          action: "conversation.run.cancel.requested",
          resourceType: "conversation_run",
          resourceId: runId,
          outcome: "success",
          metadata: { conversationId: run.conversationId, previousStatus: current.status },
        },
        tx,
      );
      return { requested: true, previousStatus: current.status };
    });
    if (!transition.requested) return this.getRun(runId, actor.actorSubjectId);

    await this.runtime.cancelRun(runId);
    return this.getRun(runId, actor.actorSubjectId);
  }

  async streamEvents(
    runId: string,
    userSubjectId: string,
    lastEventId: string | undefined,
    response: Response,
  ): Promise<void> {
    await this.getRun(runId, userSubjectId);
    let cursor = /^\d+$/.test(lastEventId ?? "") ? Number(lastEventId) : 0;
    response.status(200);
    response.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    response.write("retry: 1000\n\n");

    let polling = false;
    let terminalSnapshotSent = false;
    let lastHeartbeat = Date.now();
    const writeEvent = (name: string, data: unknown, id?: number) => {
      if (id !== undefined) response.write(`id: ${id}\n`);
      response.write(`event: ${name}\n`);
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    const poll = async () => {
      if (polling || response.writableEnded) return;
      polling = true;
      try {
        const events = await this.database.db
          .select({
            id: agentRunEvents.id,
            type: agentRunEvents.type,
            payload: agentRunEvents.payload,
          })
          .from(agentRunEvents)
          .where(and(eq(agentRunEvents.runId, runId), sql`${agentRunEvents.id} > ${cursor}`))
          .orderBy(asc(agentRunEvents.id))
          .limit(SSE_EVENT_BATCH_SIZE);
        for (const event of events) {
          cursor = event.id;
          const name = event.type === "run.reset" ? "reset" : event.type;
          writeEvent(name, event.payload, event.id);
        }
        // A full page may still have durable events after the current cursor.
        // Let the next poll drain them before a terminal snapshot closes the
        // EventSource, otherwise event 201+ would never reach the client.
        if (events.length === SSE_EVENT_BATCH_SIZE) return;
        const run = await this.getRun(runId, userSubjectId);
        if ((TERMINAL_STATUSES as readonly string[]).includes(run.status) && !terminalSnapshotSent) {
          terminalSnapshotSent = true;
          writeEvent("snapshot", { run });
          response.end();
          return;
        }
        if (Date.now() - lastHeartbeat >= 15_000) {
          lastHeartbeat = Date.now();
          response.write(`: heartbeat ${new Date().toISOString()}\n\n`);
        }
      } catch {
        if (!response.writableEnded) response.end();
      } finally {
        polling = false;
      }
    };
    const interval = setInterval(() => void poll(), SSE_POLL_INTERVAL_MS);
    interval.unref();
    response.on("close", () => clearInterval(interval));
    await poll();
  }

  private async resolveRuntimeSnapshot(
    userSubjectId: string,
    agentSubjectId: string,
  ): Promise<RuntimeSnapshot> {
    if (!(await this.access.canInvoke(userSubjectId, agentSubjectId))) {
      throw new NotFoundException("Agent is not available");
    }
    const rows = await this.database.db
      .select({
        agentId: agents.subjectId,
        slug: agents.slug,
        name: agents.name,
        description: agents.description,
        systemPrompt: agentRuntimes.systemPrompt,
        temperature: agentRuntimes.temperature,
        maxOutputTokens: agentRuntimes.maxOutputTokens,
        maxSteps: agentRuntimes.maxSteps,
        profileId: modelProfiles.id,
        profileKey: modelProfiles.key,
        modelId: modelProfiles.modelId,
      })
      .from(agents)
      .innerJoin(subjects, eq(agents.subjectId, subjects.id))
      .innerJoin(agentRuntimes, eq(agents.subjectId, agentRuntimes.agentSubjectId))
      .innerJoin(modelProfiles, eq(agentRuntimes.modelProfileId, modelProfiles.id))
      .where(
        and(
          eq(agents.subjectId, agentSubjectId),
          eq(subjects.status, "active"),
          eq(modelProfiles.status, "active"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("Agent is not available");
    const descriptors = await this.capabilities.listAvailable({
      actorSubjectId: userSubjectId,
      agentSubjectId,
      traceId: randomUUID(),
    });
    const tools = await this.resolveSnapshotTools(descriptors, agentSubjectId);
    return {
      agent: { id: row.agentId, slug: row.slug, name: row.name, description: row.description },
      profile: { id: row.profileId, key: row.profileKey, modelId: row.modelId },
      systemPrompt: row.systemPrompt,
      temperature: row.temperature,
      maxOutputTokens: row.maxOutputTokens,
      maxSteps: row.maxSteps,
      capabilities: tools.map((tool) => tool.id),
      tools,
    };
  }

  /**
   * The model-facing tool set: internal capabilities the actor and agent are
   * both authorized for, plus bound MCP tools (enabled, on an active server,
   * and dual-authorized via the same capability surface). Binding decides
   * intent; authorization decides availability; both must hold per run.
   *
   * MCP tools are named by a provider-safe derivative of their capability id
   * rather than the bare remote tool name: two servers routinely expose the
   * same tool name ("search"), and the Worker keys its provider tool set by
   * this name, so a bare name would let one server's tool silently shadow
   * another's. See deriveProviderToolName — the id stays the governed identity
   * used by events and audit rows.
   */
  private async resolveSnapshotTools(
    descriptors: CapabilityDescriptor[],
    agentSubjectId: string,
  ): Promise<RuntimeToolDescriptorV1[]> {
    const internalTools: RuntimeToolDescriptorV1[] = [];
    const mcpDescriptors: RuntimeToolDescriptorV1[] = [];
    let hasUsersSearch = false;
    for (const descriptor of descriptors) {
      if (descriptor.id === USERS_SEARCH_TOOL_ID) {
        hasUsersSearch = true;
        continue;
      }
      if (!descriptor.id.startsWith(MCP_MODULE_PREFIX)) continue;
      mcpDescriptors.push({
        id: descriptor.id,
        name: deriveProviderToolName(descriptor.id),
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
      });
    }
    if (hasUsersSearch) internalTools.push(buildUsersSearchToolDescriptor());

    const boundIds = await this.resolveBoundToolCapabilityIds(agentSubjectId);
    const selectedMcpTools = mcpDescriptors.filter((tool) => boundIds.has(tool.id));
    // mcp-* sorts before users.search, so the internal vertical is never the
    // one silently dropped when the cap is reached.
    const maxMcpTools = Math.max(0, AGENT_RUN_MAX_TOOLS - internalTools.length);
    const tools = [
      ...selectedMcpTools.slice(0, maxMcpTools),
      ...internalTools,
    ];
    tools.sort((left, right) => left.id.localeCompare(right.id));
    return tools;
  }

  private async resolveBoundToolCapabilityIds(agentSubjectId: string): Promise<Set<string>> {
    const rows = await this.database.db
      .select({ toolName: mcpTools.name, serverSlug: mcpServers.slug })
      .from(agentToolBindings)
      .innerJoin(mcpTools, eq(agentToolBindings.toolId, mcpTools.id))
      .innerJoin(mcpServers, eq(mcpTools.serverId, mcpServers.id))
      .where(
        and(
          eq(agentToolBindings.agentSubjectId, agentSubjectId),
          eq(mcpTools.enabled, true),
          eq(mcpServers.status, "active"),
        ),
      );
    const ids = new Set<string>();
    for (const row of rows) {
      const id = deriveMcpCapabilityId(row.serverSlug, row.toolName);
      if (id) ids.add(id);
    }
    return ids;
  }

  private buildTask(input: {
    runId: string;
    conversationId: string;
    actorSubjectId: string;
    snapshot: RuntimeSnapshot;
    messages: Array<{ id: string; role: "user" | "assistant"; content: string }>;
    now: Date;
  }): AgentRunTaskV1 {
    return AgentRunTaskV1Schema.parse({
      version: 1,
      kind: "agent.run",
      runId: input.runId,
      conversationId: input.conversationId,
      actorSubjectId: input.actorSubjectId,
      agentSubjectId: input.snapshot.agent.id,
      traceId: randomUUID(),
      model: {
        profileId: input.snapshot.profile.id,
        key: input.snapshot.profile.key,
        modelId: input.snapshot.profile.modelId,
        connectionId: "default",
      },
      generation: {
        temperature: input.snapshot.temperature,
        maxOutputTokens: input.snapshot.maxOutputTokens,
        maxSteps: input.snapshot.maxSteps,
      },
      systemPrompt: input.snapshot.systemPrompt,
      messages: input.messages,
      capabilities: input.snapshot.capabilities,
      tools: input.snapshot.tools,
      createdAt: input.now.toISOString(),
      deadlineAt: new Date(input.now.getTime() + 120_000).toISOString(),
    });
  }

  private async getOwnedConversation(conversationId: string, userSubjectId: string) {
    const rows = await this.database.db
      .select({
        id: conversations.id,
        userSubjectId: conversations.userSubjectId,
        agentSubjectId: conversations.agentSubjectId,
        title: conversations.title,
        agentSlug: agents.slug,
        agentName: agents.name,
        lastMessageAt: conversations.lastMessageAt,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentSubjectId, agents.subjectId))
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.userSubjectId, userSubjectId),
          isNull(conversations.deletedAt),
        ),
      )
      .limit(1);
    if (!rows[0]) throw new NotFoundException("Conversation not found");
    return rows[0];
  }

  private async getOwnedConversationForUpdate(
    tx: DatabaseTransaction,
    conversationId: string,
    userSubjectId: string,
  ) {
    await tx.execute(
      sql`select id from conversations
          where id = ${conversationId} and user_subject_id = ${userSubjectId}
          for update`,
    );
    const rows = await tx
      .select({
        id: conversations.id,
        userSubjectId: conversations.userSubjectId,
        agentSubjectId: conversations.agentSubjectId,
        title: conversations.title,
        agentSlug: agents.slug,
        agentName: agents.name,
        lastMessageAt: conversations.lastMessageAt,
        createdAt: conversations.createdAt,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .innerJoin(agents, eq(conversations.agentSubjectId, agents.subjectId))
      .where(
        and(
          eq(conversations.id, conversationId),
          eq(conversations.userSubjectId, userSubjectId),
          isNull(conversations.deletedAt),
        ),
      )
      .limit(1);
    if (!rows[0]) throw new NotFoundException("Conversation not found");
    return rows[0];
  }

  private serializeConversation(conversation: Awaited<ReturnType<ConversationsService["getOwnedConversation"]>>) {
    return {
      id: conversation.id,
      title: conversation.title,
      agent: {
        id: conversation.agentSubjectId,
        slug: conversation.agentSlug,
        name: conversation.agentName,
      },
      lastMessageAt: conversation.lastMessageAt.toISOString(),
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    };
  }

  private serializeRun(run: {
    id: string;
    conversationId: string;
    status: string;
    attempt: number;
    usage: unknown;
    finishReason: string | null;
    errorCode: string | null;
    queuedAt: Date;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    assistantMessageId: string | null;
    assistantContent: string | null;
    assistantCreatedAt: Date | null;
  }) {
    return {
      id: run.id,
      conversationId: run.conversationId,
      status: run.status,
      attempt: run.attempt,
      usage: run.usage,
      finishReason: run.finishReason,
      errorCode: run.errorCode,
      queuedAt: run.queuedAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      assistantMessage: run.assistantMessageId
        ? {
            id: run.assistantMessageId,
            role: "assistant" as const,
            content: run.assistantContent!,
            createdAt: run.assistantCreatedAt!.toISOString(),
          }
        : null,
    };
  }

  private async findIdempotentRun(userSubjectId: string, idempotencyKey: string) {
    const rows = await this.database.db
      .select({ id: agentRuns.id, conversationId: agentRuns.conversationId, requestHash: agentRuns.requestHash })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.requestedBySubjectId, userSubjectId),
          eq(agentRuns.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async resolveIdempotent(
    existing: { id: string; conversationId: string; requestHash: string },
    requestHash: string,
  ) {
    if (existing.requestHash !== requestHash) {
      throw new ConflictException("Idempotency-Key was already used for a different request");
    }
    return this.getCreateResponse(existing.conversationId, existing.id, undefined);
  }

  private async getCreateResponse(conversationId: string, runId: string, userSubjectId?: string) {
    const rows = await this.database.db
      .select({ userSubjectId: conversations.userSubjectId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    const owner = rows[0]?.userSubjectId;
    if (!owner || (userSubjectId && owner !== userSubjectId)) {
      throw new NotFoundException("Conversation not found");
    }
    const detail = await this.getDetail(conversationId, owner);
    return { conversation: detail.conversation, run: await this.getRun(runId, owner) };
  }
}
