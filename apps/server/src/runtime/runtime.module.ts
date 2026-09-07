import { Global, Module } from "@nestjs/common";
import { CapabilitiesModule } from "../capabilities/capabilities.module";
import { RuntimeService } from "./runtime.service";

@Global()
@Module({
  imports: [CapabilitiesModule],
  providers: [RuntimeService],
  exports: [RuntimeService],
})
export class RuntimeModule {}
