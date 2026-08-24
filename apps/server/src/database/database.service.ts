import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Environment } from "../config/environment";
import * as schema from "./schema";

@Injectable()
export class DatabaseService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly pool: Pool;
  readonly db: NodePgDatabase<typeof schema>;

  constructor(configService: ConfigService<Environment, true>) {
    this.pool = new Pool({ connectionString: configService.get("DATABASE_URL", { infer: true }) });
    this.db = drizzle(this.pool, { schema });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.pool.query("select 1");
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
