import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";
import type { Environment } from "../config/environment";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

@Injectable()
export class OriginGuard implements CanActivate {
  private readonly allowedOrigin: string;

  constructor(configService: ConfigService<Environment, true>) {
    this.allowedOrigin = configService.get("ADMIN_ORIGIN", { infer: true });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(request.method)) return true;
    const origin = request.get("origin");
    if (!origin || origin === this.allowedOrigin) return true;
    throw new ForbiddenException("Origin is not allowed");
  }
}
