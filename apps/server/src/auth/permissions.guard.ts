import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AuthenticatedRequest } from "./auth.types";
import { REQUIRED_PERMISSIONS_KEY } from "./auth.decorators";
import { AuthorizationService } from "../rbac/authorization.service";
import { AuditService } from "../audit/audit.service";
import { getRequestMetadata } from "./request-metadata";

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const allowed = await this.authorization.hasPermissions(request.auth.subjectId, required);
    if (allowed) return true;
    await this.audit.record({
      actorSubjectId: request.auth.subjectId,
      action: "authorization.denied",
      resourceType: "http_route",
      resourceId: `${request.method} ${request.route?.path ?? request.path}`,
      outcome: "failure",
      metadata: { requiredPermissions: required },
      ...getRequestMetadata(request),
    });
    throw new ForbiddenException();
  }
}
