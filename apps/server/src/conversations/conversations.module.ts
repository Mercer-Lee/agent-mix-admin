import { Module } from "@nestjs/common";
import { AgentsModule } from "../agents/agents.module";
import { CapabilitiesModule } from "../capabilities/capabilities.module";
import { RuntimeModule } from "../runtime/runtime.module";
import {
  ChatAgentsController,
  ConversationsController,
  RunsController,
} from "./conversations.controller";
import { ConversationsService } from "./conversations.service";

@Module({
  imports: [AgentsModule, CapabilitiesModule, RuntimeModule],
  controllers: [ChatAgentsController, ConversationsController, RunsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
