import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { AppController } from "./app.controller";
import { validateEnvironment } from "./config/environment";
import { DatabaseModule } from "./database/database.module";
import { AuditModule } from "./audit/audit.module";
import { RbacModule } from "./rbac/rbac.module";
import { AuthModule } from "./auth/auth.module";
import { OriginGuard } from "./auth/origin.guard";
import { SessionAuthGuard } from "./auth/session-auth.guard";
import { PermissionsGuard } from "./auth/permissions.guard";
import { UsersModule } from "./users/users.module";
import { RolesModule } from "./roles/roles.module";
import { CapabilitiesModule } from "./capabilities/capabilities.module";
import { AgentsModule } from "./agents/agents.module";
import { PermissionsModule } from "./permissions/permissions.module";
import { RuntimeModule } from "./runtime/runtime.module";
import { ModelsModule } from "./models/models.module";
import { DepartmentsModule } from "./departments/departments.module";
import { ConversationsModule } from "./conversations/conversations.module";
import { SafeExceptionFilter } from "./safe-exception.filter";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ["../../.env", ".env"],
      validate: validateEnvironment,
    }),
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 100 }]),
    DatabaseModule,
    RuntimeModule,
    AuditModule,
    RbacModule,
    AuthModule,
    CapabilitiesModule,
    AgentsModule,
    PermissionsModule,
    UsersModule,
    RolesModule,
    ModelsModule,
    DepartmentsModule,
    ConversationsModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_FILTER, useClass: SafeExceptionFilter },
    { provide: APP_GUARD, useClass: OriginGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
