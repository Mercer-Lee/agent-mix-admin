import type { Request } from "express";

export function getRequestMetadata(request: Request): {
  ipAddress: string | null;
  userAgent: string | null;
} {
  const forwarded = request.headers["x-forwarded-for"];
  const forwardedIp = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0]?.trim();
  return {
    ipAddress: forwardedIp ?? request.ip ?? null,
    userAgent: request.get("user-agent") ?? null,
  };
}
