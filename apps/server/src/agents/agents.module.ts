import { Module } from "@nestjs/common";
import { CapabilitiesModule } from "../capabilities/capabilities.module";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";

@Module({
  imports: [CapabilitiesModule],
  controllers: [AgentsController],
  providers: [AgentsService],
})
export class AgentsModule {}
