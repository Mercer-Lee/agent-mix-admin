import { ModelCheckTaskV1Schema } from "@agentmix/core";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { desc, eq, inArray } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import { modelChecks, modelProfiles, outboxEvents } from "../database/schema";
import type { CreateModelDto } from "./dto/create-model.dto";
import type { UpdateModelDto } from "./dto/update-model.dto";

interface ActorMetadata {
  actorSubjectId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "23505") return true;
  return "cause" in error && isUniqueViolation(error.cause);
}

@Injectable()
export class ModelsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const profiles = await this.database.db.select().from(modelProfiles).orderBy(modelProfiles.name);
    const profileIds = profiles.map((profile) => profile.id);
    // DISTINCT ON returns only the newest check per profile from the
    // (model_profile_id, created_at) index instead of scanning full history.
    const checks = profileIds.length
      ? await this.database.db
          .selectDistinctOn([modelChecks.modelProfileId])
          .from(modelChecks)
          .where(inArray(modelChecks.modelProfileId, profileIds))
          .orderBy(modelChecks.modelProfileId, desc(modelChecks.createdAt))
      : [];
    const latest = new Map<string, (typeof checks)[number]>();
    for (const check of checks) {
      if (!latest.has(check.modelProfileId)) latest.set(check.modelProfileId, check);
    }
    return {
      items: profiles.map((profile) => this.serializeProfile(profile, latest.get(profile.id) ?? null)),
    };
  }

  async create(dto: CreateModelDto, actor: ActorMetadata) {
    try {
      const profile = await this.database.db.transaction(async (tx) => {
        const rows = await tx
          .insert(modelProfiles)
          .values({
            key: dto.key,
            name: dto.name,
            description: dto.description,
            provider: "openai-compatible",
            connection: "default",
            modelId: dto.modelId,
            status: dto.status,
          })
          .returning();
        const created = rows[0]!;
        await this.audit.record(
          {
            ...actor,
            action: "model.created",
            resourceType: "model_profile",
            resourceId: created.id,
            outcome: "success",
            metadata: { key: created.key, modelId: created.modelId, status: created.status },
          },
          tx,
        );
        return created;
      });
      return this.serializeProfile(profile, null);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException("Model profile key already exists");
      throw error;
    }
  }

  async update(id: string, dto: UpdateModelDto, actor: ActorMetadata) {
    const profile = await this.database.db.transaction(async (tx) => {
      const rows = await tx
        .update(modelProfiles)
        .set({
          name: dto.name,
          description: dto.description,
          modelId: dto.modelId,
          status: dto.status,
          updatedAt: new Date(),
        })
        .where(eq(modelProfiles.id, id))
        .returning();
      const updated = rows[0];
      if (!updated) throw new NotFoundException("Model profile not found");
      await this.audit.record(
        {
          ...actor,
          action: "model.updated",
          resourceType: "model_profile",
          resourceId: id,
          outcome: "success",
          metadata: { modelId: updated.modelId, status: updated.status },
        },
        tx,
      );
      return updated;
    });
    return this.serializeProfile(profile, null);
  }

  async check(id: string, actor: ActorMetadata) {
    const check = await this.database.db.transaction(async (tx) => {
      const profileRows = await tx
        .select()
        .from(modelProfiles)
        .where(eq(modelProfiles.id, id))
        .limit(1);
      const profile = profileRows[0];
      if (!profile) throw new NotFoundException("Model profile not found");
      const rows = await tx
        .insert(modelChecks)
        .values({ modelProfileId: id, requestedBySubjectId: actor.actorSubjectId })
        .returning();
      const created = rows[0]!;
      const now = new Date();
      const task = ModelCheckTaskV1Schema.parse({
        version: 1,
        kind: "model.check",
        checkId: created.id,
        modelProfileId: id,
        modelId: profile.modelId,
        connectionId: "default",
        requestedAt: now.toISOString(),
        deadlineAt: new Date(now.getTime() + 30_000).toISOString(),
      });
      await tx.insert(outboxEvents).values({
        runId: null,
        modelCheckId: created.id,
        topic: "model.check.requested",
        deduplicationKey: created.id,
        payload: task,
      });
      await this.audit.record(
        {
          ...actor,
          action: "model.check.requested",
          resourceType: "model_profile",
          resourceId: id,
          outcome: "success",
          metadata: { checkId: created.id, modelId: profile.modelId },
        },
        tx,
      );
      return created;
    });
    return this.serializeCheck(check);
  }

  async getCheck(id: string) {
    const rows = await this.database.db
      .select()
      .from(modelChecks)
      .where(eq(modelChecks.id, id))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("Model check not found");
    return this.serializeCheck(rows[0]);
  }

  private serializeProfile(
    profile: typeof modelProfiles.$inferSelect,
    check: typeof modelChecks.$inferSelect | null,
  ) {
    return {
      id: profile.id,
      key: profile.key,
      name: profile.name,
      description: profile.description,
      provider: "openai-compatible" as const,
      connection: "default" as const,
      modelId: profile.modelId,
      status: profile.status,
      isSystem: profile.isSystem,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
      lastCheck: check ? this.serializeCheck(check) : null,
    };
  }

  private serializeCheck(check: typeof modelChecks.$inferSelect) {
    return {
      id: check.id,
      modelProfileId: check.modelProfileId,
      status: check.status,
      latencyMs: check.latencyMs,
      usage: check.usage ?? null,
      errorCode: check.errorCode,
      startedAt: check.startedAt?.toISOString() ?? null,
      completedAt: check.completedAt?.toISOString() ?? null,
      createdAt: check.createdAt.toISOString(),
      updatedAt: check.updatedAt.toISOString(),
    };
  }
}
