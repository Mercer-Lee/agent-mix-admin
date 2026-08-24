import { resolve } from "node:path";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import cookieParser from "cookie-parser";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseService } from "./database/database.service";
import { seedDatabase } from "./database/seed-data";
import {
  agents,
  auditLogs,
  departments,
  permissions,
  roles,
  sessions,
  subjectPermissions,
  subjectRoles,
  subjects,
  users,
} from "./database/schema";
import { AuthorizationService } from "./rbac/authorization.service";
import { UsersService } from "./users/users.service";
import { CapabilityExecutor } from "./capabilities/capability.executor";

process.env.TESTCONTAINERS_RYUK_DISABLED = "true";

describe("Phase 1A control plane", () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let database: DatabaseService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:15-alpine").start();
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = container.getConnectionUri();
    process.env.ADMIN_ORIGIN = "http://localhost:3100";
    process.env.SESSION_TTL_HOURS = "12";
    process.env.BOOTSTRAP_ADMIN_USERNAME = "admin";
    process.env.BOOTSTRAP_ADMIN_PASSWORD = "correct-horse-battery-staple";

    const migrationPool = new Pool({ connectionString: process.env.DATABASE_URL });
    await migrate(drizzle(migrationPool), {
      migrationsFolder: resolve(process.cwd(), "drizzle"),
    });
    await migrationPool.end();

    const { AppModule } = await import("./app.module");
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
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
    });
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it("runs migrations and bootstrap seed idempotently", async () => {
    await seedDatabase(database.db, {
      BOOTSTRAP_ADMIN_USERNAME: "admin",
      BOOTSTRAP_ADMIN_PASSWORD: "correct-horse-battery-staple",
    });
    const [userCount, roleCount] = await Promise.all([
      database.db.select({ value: count() }).from(users).where(eq(users.username, "admin")),
      database.db.select({ value: count() }).from(roles).where(eq(roles.key, "super-admin")),
    ]);
    expect(userCount[0]?.value).toBe(1);
    expect(roleCount[0]?.value).toBe(1);
  });

  it("reports database health", async () => {
    await request(app.getHttpServer()).get("/api/health").expect(200).expect(({ body }) => {
      expect(body).toMatchObject({ status: "ok", database: "ok" });
    });
  });

  it("rejects foreign origins and generic invalid credentials", async () => {
    await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("origin", "https://attacker.example")
      .send({ username: "admin", password: "correct-horse-battery-staple" })
      .expect(403);

    await request(app.getHttpServer())
      .post("/api/auth/login")
      .set("origin", "http://localhost:3100")
      .send({ username: "missing", password: "incorrect-password" })
      .expect(401)
      .expect(({ body }) => expect(body.message).toBe("Invalid credentials"));
  });

  it("authenticates, applies RBAC immediately, and audits protected operations", async () => {
    const admin = request.agent(app.getHttpServer());
    const login = await admin
      .post("/api/auth/login")
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
      .set("origin", "http://localhost:3100")
      .send({ username: "operator", password: "operator-password-123" })
      .expect(200);
    await operator.get("/api/users").expect(403);

    const roleList = await admin.get("/api/roles").expect(200);
    const superAdminId = roleList.body[0].id as string;
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
            input: { page: 1, pageSize: 20, search: "admin" },
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

  it("invalidates expired and disabled sessions immediately", async () => {
    const client = request.agent(app.getHttpServer());
    const login = await client
      .post("/api/auth/login")
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
        .set("origin", "http://localhost:3100")
        .send({ username: "missing", password: "incorrect-password" });
      statuses.push(response.status);
      if (response.status === 429) break;
    }
    expect(statuses).toContain(429);
  });
});
