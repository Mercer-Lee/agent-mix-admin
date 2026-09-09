import { Module } from "@nestjs/common";
import { CapabilitiesModule } from "../capabilities/capabilities.module";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";
import { AgentAccessService } from "./agent-access.service";

@Module({
  imports: [CapabilitiesModule],
  controllers: [AgentsController],
  providers: [AgentsService, AgentAccessService],
  exports: [AgentsService, AgentAccessService],
})
export class AgentsModule {}
