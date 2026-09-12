import { Global, Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { RbacModule } from "../rbac/rbac.module";
import { CapabilityExecutor } from "./capability.executor";
import { CapabilityRegistry } from "./capability.registry";
import { CapabilityResolver } from "./capability.resolver";
import { CapabilitySourceRegistry } from "./capability-source.registry";

/**
 * Global so capability-owning modules (users, mcp) can provide a
 * CAPABILITY_SOURCE without importing this module back — that would be a cycle,
 * since they register into the registry this module owns while the executor
 * resolves through their source on a miss.
 *
 * Sources register themselves into CapabilitySourceRegistry at runtime instead
 * of being injected: the module that owns a source imports this one to reach the
 * registry, so injecting the source back would be a cycle Nest cannot resolve.
 */
@Global()
@Module({
  imports: [AuditModule, RbacModule],
  providers: [
    CapabilityRegistry,
    CapabilitySourceRegistry,
    CapabilityResolver,
    CapabilityExecutor,
  ],
  exports: [
    CapabilityRegistry,
    CapabilitySourceRegistry,
    CapabilityResolver,
    CapabilityExecutor,
  ],
})
export class CapabilitiesModule {}
