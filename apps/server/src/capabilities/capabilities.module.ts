import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { RbacModule } from "../rbac/rbac.module";
import { CapabilityExecutor } from "./capability.executor";
import { CapabilityRegistry } from "./capability.registry";

@Module({
  imports: [AuditModule, RbacModule],
  providers: [CapabilityRegistry, CapabilityExecutor],
  exports: [CapabilityRegistry, CapabilityExecutor],
})
export class CapabilitiesModule {}
