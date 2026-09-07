import { Module } from "@nestjs/common";
import { RuntimeModule } from "../runtime/runtime.module";
import { ModelChecksController, ModelsController } from "./models.controller";
import { ModelsService } from "./models.service";

@Module({
  imports: [RuntimeModule],
  controllers: [ModelsController, ModelChecksController],
  providers: [ModelsService],
  exports: [ModelsService],
})
export class ModelsModule {}
