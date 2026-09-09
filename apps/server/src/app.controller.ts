import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { Public } from "./auth/auth.decorators";
import { DatabaseService } from "./database/database.service";
import { RuntimeService } from "./runtime/runtime.service";

@Controller("health")
export class AppController {
  constructor(
    private readonly database: DatabaseService,
    private readonly runtime: RuntimeService,
  ) {}

  @Public()
  @Get()
  async health() {
    let databaseStatus: "ok" | "down" = "ok";
    try {
      await this.database.pool.query("select 1");
    } catch {
      databaseStatus = "down";
    }
    const runtime = await this.runtime.getHealth();
    const status =
      databaseStatus === "down" || runtime.redis.status === "down"
        ? "down"
        : runtime.worker.status === "ok"
          ? "ok"
          : "warn";
    if (databaseStatus === "down") throw new ServiceUnavailableException({
      status,
      service: "agentmix-server",
      database: { status: databaseStatus },
      ...runtime,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
    return {
      status,
      service: "agentmix-server",
      database: { status: databaseStatus },
      ...runtime,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
