import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { Public } from "./auth/auth.decorators";
import { DatabaseService } from "./database/database.service";

@Controller("health")
export class AppController {
  constructor(private readonly database: DatabaseService) {}

  @Public()
  @Get()
  async health() {
    try {
      await this.database.pool.query("select 1");
    } catch {
      throw new ServiceUnavailableException("database unavailable");
    }
    return {
      status: "ok" as const,
      service: "agentmix-server",
      database: "ok" as const,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
