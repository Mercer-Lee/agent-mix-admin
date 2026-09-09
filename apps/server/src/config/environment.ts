import { isIP } from "node:net";
import { z } from "zod";

function normalizeAdminOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.origin === "null" ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export type TrustProxy = false | string[];

export function parseTrustProxy(value: string): TrustProxy {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "false") return false;

  const cidrs = value.split(",").map((entry) => entry.trim());
  for (const cidr of cidrs) {
    const match = /^(.*)\/(\d{1,3})$/.exec(cidr);
    const address = match?.[1] ?? "";
    const version = isIP(address);
    const prefix = Number(match?.[2]);
    const maxPrefix = version === 4 ? 32 : 128;
    if (!version || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      throw new Error("TRUST_PROXY must be false or a comma-separated list of IPv4/IPv6 CIDRs");
    }
  }
  return cidrs;
}

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).startsWith("postgres"),
  REDIS_URL: z.string().min(1).startsWith("redis").default("redis://localhost:6379"),
  ADMIN_ORIGIN: z
    .url()
    .default("http://localhost:3100")
    .refine((value) => normalizeAdminOrigin(value) !== null, {
      message: "Must be a serialized HTTP(S) origin without credentials or a path",
    })
    .transform((value) => normalizeAdminOrigin(value)!),
  TRUST_PROXY: z.string().default("false").transform(parseTrustProxy),
  SERVER_PORT: z.coerce.number().int().positive().max(65535).default(3101),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  BOOTSTRAP_ADMIN_USERNAME: z.string().default("admin"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),
  MODEL: z.string().trim().min(1).default("gpt-4o-mini"),
});

export type Environment = z.infer<typeof EnvironmentSchema>;

export function validateEnvironment(input: Record<string, unknown>): Environment {
  const result = EnvironmentSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
