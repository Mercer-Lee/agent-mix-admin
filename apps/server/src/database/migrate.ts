import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { loadEnvironmentFiles } from "../config/load-env";
import { validateEnvironment } from "../config/environment";

async function main(): Promise<void> {
  loadEnvironmentFiles();
  const environment = validateEnvironment(process.env);
  const pool = new Pool({ connectionString: environment.DATABASE_URL });
  try {
    await migrate(drizzle(pool), { migrationsFolder: resolve(process.cwd(), "drizzle") });
    console.log("[database] migrations applied");
  } finally {
    await pool.end();
  }
}

void main();
