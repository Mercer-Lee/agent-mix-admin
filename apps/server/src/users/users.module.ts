import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CapabilitiesModule } from "../capabilities/capabilities.module";
import { UsersController } from "./users.controller";
import { UsersCapabilities } from "./users.capabilities";
import { UsersService } from "./users.service";

@Module({
  imports: [AuthModule, CapabilitiesModule],
  controllers: [UsersController],
  providers: [UsersService, UsersCapabilities],
})
export class UsersModule {}
