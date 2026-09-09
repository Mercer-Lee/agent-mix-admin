import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import type { Environment } from "../config/environment";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isAllowedRequestOrigin(
  method: string,
  origin: string | undefined,
  allowedOrigin: string,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  if (!origin || origin !== allowedOrigin) return false;
  try {
    const url = new URL(origin);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

@Injectable()
export class OriginGuard implements CanActivate {
  private readonly allowedOrigin: string;

  constructor(configService: ConfigService<Environment, true>) {
    this.allowedOrigin = configService.get("ADMIN_ORIGIN", { infer: true });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const origin = request.get("origin");
    if (isAllowedRequestOrigin(request.method, origin, this.allowedOrigin)) return true;
    throw new ForbiddenException("Origin is not allowed");
  }
}
