import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class AppController {
  @Get()
  health() {
    return {
      status: "ok" as const,
      service: "agentmix-server",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
