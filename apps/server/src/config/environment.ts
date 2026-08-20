import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).startsWith("postgres"),
  ADMIN_ORIGIN: z.url().default("http://localhost:3100"),
  SERVER_PORT: z.coerce.number().int().positive().max(65535).default(3101),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  BOOTSTRAP_ADMIN_USERNAME: z.string().default("admin"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
});

export type Environment = z.infer<typeof EnvironmentSchema>;

export function validateEnvironment(input: Record<string, unknown>): Environment {
  const result = EnvironmentSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
