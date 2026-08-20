import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { loadEnvironmentFiles } from "../config/load-env";
import { validateEnvironment } from "../config/environment";
import * as schema from "./schema";
import { seedDatabase } from "./seed-data";

async function main(): Promise<void> {
  loadEnvironmentFiles();
  const environment = validateEnvironment(process.env);
  const pool = new Pool({ connectionString: environment.DATABASE_URL });
  const db = drizzle(pool, { schema });

  try {
    const username = await seedDatabase(db, environment);
    console.log(`[database] bootstrap administrator ready: ${username}`);
  } finally {
    await pool.end();
  }
}

void main();
