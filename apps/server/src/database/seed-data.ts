import { hash } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Environment } from "../config/environment";
import { CORE_PERMISSIONS } from "../rbac/permissions";
import * as schema from "./schema";
import {
  agentRoleAccessGrants,
  agentRuntimes,
  agents,
  modelProfiles,
  permissions,
  roles,
  subjectPermissions,
  subjectRoles,
  subjects,
  users,
} from "./schema";

const SYSTEM_AGENT_SLUG = "agentmix-assistant";
const DEFAULT_MODEL_PROFILE_KEY = "default";

export async function seedDatabase(
  db: NodePgDatabase<typeof schema>,
  environment: Pick<
    Environment,
    "BOOTSTRAP_ADMIN_USERNAME" | "BOOTSTRAP_ADMIN_PASSWORD"
  > & { MODEL?: string },
): Promise<string> {
  const username = environment.BOOTSTRAP_ADMIN_USERNAME.trim().toLowerCase();
  const password = environment.BOOTSTRAP_ADMIN_PASSWORD;
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new Error("BOOTSTRAP_ADMIN_USERNAME must match ^[a-z0-9._-]{3,32}$");
  }
  if (!password || password.length < 12 || password.length > 128) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD must contain between 12 and 128 characters");
  }
  const modelId = environment.MODEL?.trim() || "gpt-4o-mini";

  await db.transaction(async (tx) => {
    await tx.insert(permissions).values([...CORE_PERMISSIONS]).onConflictDoNothing();
    const permissionKeys = new Set(CORE_PERMISSIONS.map(({ resource, action }) => `${resource}:${action}`));
    const allPermissionRows = (await tx
      .select({ id: permissions.id, resource: permissions.resource, action: permissions.action })
      .from(permissions))
      .filter((permission) => permissionKeys.has(`${permission.resource}:${permission.action}`));

    let role = await tx
      .select({ id: roles.subjectId })
      .from(roles)
      .where(eq(roles.key, "super-admin"))
      .limit(1);
    if (!role[0]) {
      const roleSubject = await tx.insert(subjects).values({ type: "role" }).returning({ id: subjects.id });
      await tx.insert(roles).values({
        subjectId: roleSubject[0]!.id,
        key: "super-admin",
        name: "超级管理员",
        description: "System role with every permission registered in the open-source core",
        isSystem: true,
      });
      role = [{ id: roleSubject[0]!.id }];
    }
    await tx
      .insert(subjectPermissions)
      .values(allPermissionRows.map((permission) => ({ subjectId: role[0]!.id, permissionId: permission.id })))
      .onConflictDoNothing();

    await tx
      .insert(modelProfiles)
      .values({
        key: DEFAULT_MODEL_PROFILE_KEY,
        name: "Default",
        description: "Environment-backed default OpenAI-compatible model profile",
        modelId,
        isSystem: true,
      })
      .onConflictDoUpdate({
        target: modelProfiles.key,
        set: {
          name: "Default",
          description: "Environment-backed default OpenAI-compatible model profile",
          modelId,
          isSystem: true,
          updatedAt: new Date(),
        },
      });
    const defaultModel = await tx
      .select({ id: modelProfiles.id })
      .from(modelProfiles)
      .where(eq(modelProfiles.key, DEFAULT_MODEL_PROFILE_KEY))
      .limit(1);

    let systemAgent = await tx
      .select({ id: agents.subjectId })
      .from(agents)
      .where(eq(agents.slug, SYSTEM_AGENT_SLUG))
      .limit(1);
    if (!systemAgent[0]) {
      const agentSubject = await tx
        .insert(subjects)
        .values({ type: "agent" })
        .returning({ id: subjects.id });
      await tx.insert(agents).values({
        subjectId: agentSubject[0]!.id,
        slug: SYSTEM_AGENT_SLUG,
        name: "AgentMix Assistant",
        description: "Governed built-in assistant for the AgentMix workspace",
        isSystem: true,
      });
      systemAgent = [{ id: agentSubject[0]!.id }];
    } else {
      await tx.update(agents).set({ isSystem: true }).where(eq(agents.subjectId, systemAgent[0].id));
    }

    await tx
      .insert(agentRuntimes)
      .values({
        agentSubjectId: systemAgent[0]!.id,
        modelProfileId: defaultModel[0]!.id,
        systemPrompt:
          "You are AgentMix Assistant. Help users operate internal systems safely, accurately, and within granted capabilities.",
      })
      .onConflictDoNothing();
    const usersReadPermission = allPermissionRows.find(
      (permission) => permission.resource === "users" && permission.action === "read",
    );
    if (!usersReadPermission) throw new Error("Core permission users:read was not seeded");
    await tx
      .insert(subjectPermissions)
      .values({ subjectId: systemAgent[0]!.id, permissionId: usersReadPermission.id })
      .onConflictDoNothing();
    await tx
      .insert(agentRoleAccessGrants)
      .values({ agentSubjectId: systemAgent[0]!.id, roleSubjectId: role[0]!.id })
      .onConflictDoNothing();

    let admin = await tx
      .select({ id: users.subjectId })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    if (!admin[0]) {
      const userSubject = await tx.insert(subjects).values({ type: "user" }).returning({ id: subjects.id });
      const passwordHash = await hash(password, {
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1,
        outputLen: 32,
      });
      await tx.insert(users).values({
        subjectId: userSubject[0]!.id,
        username,
        displayName: "Administrator",
        passwordHash,
      });
      admin = [{ id: userSubject[0]!.id }];
    }
    await tx
      .insert(subjectRoles)
      .values({ subjectId: admin[0]!.id, roleId: role[0]!.id })
      .onConflictDoNothing();
  });
  return username;
}
