import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { CapabilitiesModule } from "../capabilities/capabilities.module";
import { McpClientService } from "./mcp-client.service";
import { McpService } from "./mcp.service";
import { McpServersController, McpToolsController } from "./mcp.controller";

@Module({
  imports: [AuditModule, CapabilitiesModule],
  controllers: [McpServersController, McpToolsController],
  providers: [McpClientService, McpService],
  exports: [McpService],
})
export class McpModule {}
