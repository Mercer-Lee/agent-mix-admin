import { Injectable } from "@nestjs/common";
import {
  CapabilityError,
  CapabilityExecutionContextSchema,
  type CapabilityDescriptor,
  type CapabilityErrorCode,
  type CapabilityExecutionContext,
} from "@agentmix/core";
import { AuditService } from "../audit/audit.service";
import { AuthorizationService } from "../rbac/authorization.service";
import type { AnyRegisteredCapability } from "./capability.types";
import { CapabilityRegistry } from "./capability.registry";
import { CapabilityResolver } from "./capability.resolver";

interface AuthorizationResult {
  actorPermissions: string[] | null;
  agentPermissions: string[] | null;
}

@Injectable()
export class CapabilityExecutor {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
    private readonly resolver: CapabilityResolver,
  ) {}

  async listAvailable(context: CapabilityExecutionContext): Promise<CapabilityDescriptor[]> {
    const parsedContext = this.parseContext(context);
    const authorization = await this.resolveAuthorization(parsedContext);
    if (!authorization.actorPermissions || !authorization.agentPermissions) return [];

    const actorPermissions = new Set(authorization.actorPermissions);
    const agentPermissions = new Set(authorization.agentPermissions);
    return this.registry.list().filter((descriptor) =>
      descriptor.requiredPermissions.every(
        (permission) => actorPermissions.has(permission) && agentPermissions.has(permission),
      ),
    );
  }

  async execute(
    id: string,
    input: unknown,
    context: CapabilityExecutionContext,
  ): Promise<unknown> {
    const parsedContext = this.parseContext(context);
    // Resolved rather than read straight from the registry: a capability
    // request is served by whichever instance consumes it from the shared
    // queue, which may not be the instance that warmed the registry at boot.
    const capability = await this.resolver.resolve(id);
    if (!capability) {
      await this.recordFailure(id, parsedContext, "CAPABILITY_NOT_FOUND");
      throw new CapabilityError("CAPABILITY_NOT_FOUND", `Capability "${id}" was not found`);
    }

    const authorization = await this.resolveAuthorization(parsedContext);
    if (!this.isAllowed(capability, authorization)) {
      await this.audit.record({
        actorSubjectId: authorization.actorPermissions ? parsedContext.actorSubjectId : null,
        action: "capability.authorization.denied",
        resourceType: "capability",
        resourceId: capability.manifest.id,
        outcome: "failure",
        metadata: this.baseAuditMetadata(capability, parsedContext, {
          errorCode: "CAPABILITY_FORBIDDEN",
          requiredPermissions: capability.manifest.requiredPermissions,
        }),
      });
      throw new CapabilityError("CAPABILITY_FORBIDDEN", "Capability access denied");
    }

    const parsedInput = capability.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      await this.recordFailure(
        capability.manifest.id,
        parsedContext,
        "CAPABILITY_INPUT_INVALID",
        capability,
        { issues: parsedInput.error.issues },
      );
      throw new CapabilityError(
        "CAPABILITY_INPUT_INVALID",
        "Capability input validation failed",
        parsedInput.error.issues,
      );
    }

    let output: unknown;
    try {
      output = await capability.execute(parsedInput.data, parsedContext);
    } catch (error) {
      await this.recordFailure(
        capability.manifest.id,
        parsedContext,
        "CAPABILITY_EXECUTION_FAILED",
        capability,
        { input: this.projectAuditInput(capability, parsedInput.data) },
      );
      throw new CapabilityError(
        "CAPABILITY_EXECUTION_FAILED",
        "Capability execution failed",
        undefined,
        { cause: error },
      );
    }

    const parsedOutput = capability.outputSchema.safeParse(output);
    if (!parsedOutput.success) {
      await this.recordFailure(
        capability.manifest.id,
        parsedContext,
        "CAPABILITY_OUTPUT_INVALID",
        capability,
        {
          input: this.projectAuditInput(capability, parsedInput.data),
          issues: parsedOutput.error.issues,
        },
      );
      throw new CapabilityError(
        "CAPABILITY_OUTPUT_INVALID",
        "Capability output validation failed",
        parsedOutput.error.issues,
      );
    }

    await this.audit.record({
      actorSubjectId: parsedContext.actorSubjectId,
      action: "capability.executed",
      resourceType: "capability",
      resourceId: capability.manifest.id,
      outcome: "success",
      metadata: this.baseAuditMetadata(capability, parsedContext, {
        input: this.projectAuditInput(capability, parsedInput.data),
        output: this.projectAuditOutput(capability, parsedOutput.data),
      }),
    });
    return parsedOutput.data;
  }

  private parseContext(context: CapabilityExecutionContext): CapabilityExecutionContext {
    const parsed = CapabilityExecutionContextSchema.safeParse(context);
    if (!parsed.success) {
      throw new CapabilityError(
        "CAPABILITY_FORBIDDEN",
        "Capability execution context is invalid",
        parsed.error.issues,
      );
    }
    return parsed.data;
  }

  private resolveAuthorization(context: CapabilityExecutionContext): Promise<AuthorizationResult> {
    return Promise.all([
      this.authorization.getEffectivePermissionsForSubject(context.actorSubjectId, "user"),
      this.authorization.getEffectivePermissionsForSubject(context.agentSubjectId, "agent"),
    ]).then(([actorPermissions, agentPermissions]) => ({ actorPermissions, agentPermissions }));
  }

  private isAllowed(
    capability: AnyRegisteredCapability,
    authorization: AuthorizationResult,
  ): boolean {
    if (!authorization.actorPermissions || !authorization.agentPermissions) return false;
    const actorPermissions = new Set(authorization.actorPermissions);
    const agentPermissions = new Set(authorization.agentPermissions);
    return capability.manifest.requiredPermissions.every(
      (permission) => actorPermissions.has(permission) && agentPermissions.has(permission),
    );
  }

  private async recordFailure(
    id: string,
    context: CapabilityExecutionContext,
    errorCode: CapabilityErrorCode,
    capability?: AnyRegisteredCapability,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const actorPermissions = await this.authorization.getEffectivePermissionsForSubject(
      context.actorSubjectId,
      "user",
    );
    await this.audit.record({
      actorSubjectId: actorPermissions ? context.actorSubjectId : null,
      action: "capability.execution.failed",
      resourceType: "capability",
      resourceId: id,
      outcome: "failure",
      metadata: capability
        ? this.baseAuditMetadata(capability, context, { errorCode, ...metadata })
        : {
            agentSubjectId: context.agentSubjectId,
            traceId: context.traceId,
            conversationId: context.conversationId,
            errorCode,
            ...metadata,
          },
    });
  }

  private baseAuditMetadata(
    capability: AnyRegisteredCapability,
    context: CapabilityExecutionContext,
    metadata: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      agentSubjectId: context.agentSubjectId,
      capabilityVersion: capability.manifest.version,
      risk: capability.manifest.risk,
      traceId: context.traceId,
      conversationId: context.conversationId,
      ...metadata,
    };
  }

  private projectAuditInput(capability: AnyRegisteredCapability, input: unknown): Record<string, unknown> {
    try {
      return capability.audit?.input?.(input) ?? {};
    } catch {
      return { projectionFailed: true };
    }
  }

  private projectAuditOutput(capability: AnyRegisteredCapability, output: unknown): Record<string, unknown> {
    try {
      return capability.audit?.output?.(output) ?? {};
    } catch {
      return { projectionFailed: true };
    }
  }
}
