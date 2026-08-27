import { hash } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Environment } from "../config/environment";
import { CORE_PERMISSIONS } from "../rbac/permissions";
import * as schema from "./schema";
import { permissions, roles, subjectPermissions, subjectRoles, subjects, users } from "./schema";

export async function seedDatabase(
  db: NodePgDatabase<typeof schema>,
  environment: Pick<Environment, "BOOTSTRAP_ADMIN_USERNAME" | "BOOTSTRAP_ADMIN_PASSWORD">,
): Promise<string> {
  const username = environment.BOOTSTRAP_ADMIN_USERNAME.trim().toLowerCase();
  const password = environment.BOOTSTRAP_ADMIN_PASSWORD;
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    throw new Error("BOOTSTRAP_ADMIN_USERNAME must match ^[a-z0-9._-]{3,32}$");
  }
  if (!password || password.length < 12 || password.length > 128) {
    throw new Error("BOOTSTRAP_ADMIN_PASSWORD must contain between 12 and 128 characters");
  }

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
