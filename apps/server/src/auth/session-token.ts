import { createHash, randomBytes } from "node:crypto";

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isSessionUsable(session: { expiresAt: Date; revokedAt: Date | null }, now = new Date()): boolean {
  return session.revokedAt === null && session.expiresAt.getTime() > now.getTime();
}
