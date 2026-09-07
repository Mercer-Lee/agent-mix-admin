import { afterEach, describe, expect, it } from "vitest";
import { loadWorkerConfig, selectWorkerEnvironment } from "./config";

const ENV_NAMES = ["REDIS_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"] as const;
const original = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));

function setRequiredEnvironment(baseUrl: string): void {
  process.env.REDIS_URL = "redis://127.0.0.1:6379";
  process.env.OPENAI_API_KEY = "sentinel-test-key";
  process.env.OPENAI_BASE_URL = baseUrl;
}

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = original.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Worker environment validation", () => {
  it("selects only execution-plane variables from a parsed workspace environment", () => {
    expect(
      selectWorkerEnvironment({
        REDIS_URL: "redis://127.0.0.1:6379",
        OPENAI_API_KEY: "sentinel-test-key",
        OPENAI_BASE_URL: "https://api.example.test/v1",
        DATABASE_URL: "sentinel-database-url",
        BOOTSTRAP_ADMIN_PASSWORD: "sentinel-bootstrap-password",
      }),
    ).toEqual({
      REDIS_URL: "redis://127.0.0.1:6379",
      OPENAI_API_KEY: "sentinel-test-key",
      OPENAI_BASE_URL: "https://api.example.test/v1",
    });
  });

  it.each([
    "https://api.example.test/v1",
    "http://localhost:8080/v1",
    "http://127.0.0.1:8080/v1",
  ])("accepts the supported model endpoint form %s", (baseUrl) => {
    setRequiredEnvironment(baseUrl);
    expect(() => loadWorkerConfig()).not.toThrow();
  });

  it.each(["http://api.example.test/v1", "ftp://localhost/model"])(
    "rejects an unsafe model endpoint form %s",
    (baseUrl) => {
      setRequiredEnvironment(baseUrl);
      expect(() => loadWorkerConfig()).toThrow(
        "OPENAI_BASE_URL must use HTTPS, or HTTP on localhost/127.0.0.1 for local testing",
      );
    },
  );

  it("reports only the missing variable name", () => {
    setRequiredEnvironment("https://api.example.test/v1");
    delete process.env.OPENAI_API_KEY;
    expect(() => loadWorkerConfig()).toThrow("Missing required environment variable: OPENAI_API_KEY");
  });
});
