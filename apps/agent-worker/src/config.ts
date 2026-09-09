import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";

const WORKER_ENV_NAMES = ["REDIS_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"] as const;
type WorkerEnvName = (typeof WORKER_ENV_NAMES)[number];
type EnvironmentSource = Record<string, string | undefined>;

export interface WorkerConfig {
  redisUrl: string;
  openaiApiKey: string;
  openaiBaseUrl: string;
}

export function selectWorkerEnvironment(source: EnvironmentSource): EnvironmentSource {
  return Object.fromEntries(
    WORKER_ENV_NAMES.flatMap((name) =>
      typeof source[name] === "string" ? [[name, source[name]]] : [],
    ),
  );
}

export function loadWorkerEnvironment(): EnvironmentSource {
  let workspaceEnvironment: EnvironmentSource = {};
  try {
    // Turbo executes packages with package-local working directories. Parse the
    // private workspace file as data and select only Worker-owned keys instead
    // of injecting unrelated control-plane secrets into process.env.
    const path = fileURLToPath(new URL("../../../.env", import.meta.url));
    workspaceEnvironment = selectWorkerEnvironment(parseDotenv(readFileSync(path)));
  } catch {
    // Production deployments normally provide process environment variables
    // directly; a local .env file is optional.
  }
  return { ...workspaceEnvironment, ...selectWorkerEnvironment(process.env) };
}

function requireEnv(environment: EnvironmentSource, name: WorkerEnvName): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadWorkerConfig(environment: EnvironmentSource = process.env): WorkerConfig {
  const redisUrl = requireEnv(environment, "REDIS_URL");
  const openaiApiKey = requireEnv(environment, "OPENAI_API_KEY");
  const openaiBaseUrl = requireEnv(environment, "OPENAI_BASE_URL");

  try {
    const parsed = new URL(openaiBaseUrl);
    const isHttps = parsed.protocol === "https:";
    const isLocalHttp =
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    if (!isHttps && !isLocalHttp) {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new Error(
      "OPENAI_BASE_URL must use HTTPS, or HTTP on localhost/127.0.0.1 for local testing",
    );
  }

  return { redisUrl, openaiApiKey, openaiBaseUrl };
}
