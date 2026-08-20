import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { Environment } from "../config/environment";
import { AuditService } from "../audit/audit.service";
import { DatabaseService } from "../database/database.service";
import { departments, sessions, subjects, users } from "../database/schema";
import { AuthorizationService } from "../rbac/authorization.service";
import type { AuthContext, SessionIdentity } from "./auth.types";
import { PasswordService } from "./password.service";
import { createSessionToken, hashSessionToken } from "./session-token";

interface ClientMetadata {
  ipAddress?: string | null;
  userAgent?: string | null;
}

@Injectable()
export class AuthService {
  private readonly sessionTtlHours: number;

  constructor(
    private readonly database: DatabaseService,
    private readonly passwords: PasswordService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
    configService: ConfigService<Environment, true>,
  ) {
    this.sessionTtlHours = configService.get("SESSION_TTL_HOURS", { infer: true });
  }

  async login(
    username: string,
    password: string,
    metadata: ClientMetadata,
  ): Promise<{ token: string; expiresAt: Date; context: AuthContext }> {
    const rows = await this.database.db
      .select({
        subjectId: users.subjectId,
        passwordHash: users.passwordHash,
        status: subjects.status,
      })
      .from(users)
      .innerJoin(subjects, eq(users.subjectId, subjects.id))
      .where(eq(users.username, username))
      .limit(1);

    const user = rows[0];
    const passwordMatches = await this.passwords.verifyOrDummy(user?.passwordHash ?? null, password);
    if (!user || user.status !== "active" || !passwordMatches) {
      await this.audit.record({
        actorSubjectId: user?.subjectId,
        action: "auth.login.failed",
        resourceType: "session",
        outcome: "failure",
        metadata: { username },
        ...metadata,
      });
      throw new UnauthorizedException("Invalid credentials");
    }

    const token = createSessionToken();
    const expiresAt = new Date(Date.now() + this.sessionTtlHours * 60 * 60 * 1000);
    await this.database.db.insert(sessions).values({
      userSubjectId: user.subjectId,
      tokenHash: hashSessionToken(token),
      expiresAt,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
    });

    await this.audit.record({
      actorSubjectId: user.subjectId,
      action: "auth.login.succeeded",
      resourceType: "session",
      outcome: "success",
      ...metadata,
    });

    return { token, expiresAt, context: await this.buildContext(user.subjectId) };
  }

  async authenticate(token: string): Promise<SessionIdentity | null> {
    const now = new Date();
    const rows = await this.database.db
      .select({
        sessionId: sessions.id,
        subjectId: users.subjectId,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        subjectStatus: subjects.status,
        departmentId: departments.id,
        departmentCode: departments.code,
        departmentName: departments.name,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userSubjectId, users.subjectId))
      .innerJoin(subjects, eq(users.subjectId, subjects.id))
      .leftJoin(departments, eq(users.departmentId, departments.id))
      .where(
        and(
          eq(sessions.tokenHash, hashSessionToken(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, now),
          eq(subjects.status, "active"),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    await this.database.db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId));
    const roles = await this.authorization.getRoles(row.subjectId);
    const permissions = await this.authorization.getEffectivePermissions(row.subjectId);
    return {
      sessionId: row.sessionId,
      subjectId: row.subjectId,
      context: {
        user: {
          id: row.subjectId,
          username: row.username,
          displayName: row.displayName,
          email: row.email,
          department: row.departmentId
            ? { id: row.departmentId, code: row.departmentCode!, name: row.departmentName! }
            : null,
        },
        roles,
        permissions,
      },
    };
  }

  async logout(token: string | undefined, metadata: ClientMetadata): Promise<void> {
    if (!token) return;
    const revoked = await this.database.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.tokenHash, hashSessionToken(token)), isNull(sessions.revokedAt)))
      .returning({ subjectId: sessions.userSubjectId });

    if (revoked[0]) {
      await this.audit.record({
        actorSubjectId: revoked[0].subjectId,
        action: "auth.logout",
        resourceType: "session",
        outcome: "success",
        ...metadata,
      });
    }
  }

  private async buildContext(subjectId: string): Promise<AuthContext> {
    const rows = await this.database.db
      .select({
        id: users.subjectId,
        username: users.username,
        displayName: users.displayName,
        email: users.email,
        departmentId: departments.id,
        departmentCode: departments.code,
        departmentName: departments.name,
      })
      .from(users)
      .leftJoin(departments, eq(users.departmentId, departments.id))
      .where(eq(users.subjectId, subjectId))
      .limit(1);
    const user = rows[0];
    if (!user) throw new UnauthorizedException();
    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        email: user.email,
        department: user.departmentId
          ? { id: user.departmentId, code: user.departmentCode!, name: user.departmentName! }
          : null,
      },
      roles: await this.authorization.getRoles(subjectId),
      permissions: await this.authorization.getEffectivePermissions(subjectId),
    };
  }
}
