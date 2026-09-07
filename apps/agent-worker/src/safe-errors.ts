import type { RuntimeSafeErrorCodeV1 } from "@agentmix/core";

export interface RuntimeErrorClassification {
  code: RuntimeSafeErrorCodeV1;
  retryable: boolean;
}

export class CapabilityBridgeError extends Error {
  constructor() {
    super("Capability execution failed");
    this.name = "CapabilityBridgeError";
  }
}

function objectValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return Reflect.get(value, key);
}

function findStatusCode(error: unknown): number | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    const candidate = objectValue(current, "statusCode") ?? objectValue(current, "status");
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
    current = objectValue(current, "cause") ?? objectValue(current, "lastError");
  }
  return undefined;
}

function findCode(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    const code = objectValue(current, "code");
    if (typeof code === "string") return code;
    current = objectValue(current, "cause") ?? objectValue(current, "lastError");
  }
  return undefined;
}

function hasNamedCause(error: unknown, name: string): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (objectValue(current, "name") === name) return true;
    current = objectValue(current, "cause") ?? objectValue(current, "lastError");
  }
  return false;
}

export function classifyRuntimeError(error: unknown): RuntimeErrorClassification {
  if (hasNamedCause(error, "CapabilityBridgeError")) {
    return { code: "capability_failed", retryable: false };
  }

  const statusCode = findStatusCode(error);
  if (statusCode === 401 || statusCode === 403) {
    return { code: "provider_authentication", retryable: false };
  }
  if (statusCode === 408) return { code: "provider_timeout", retryable: true };
  if (statusCode === 429) return { code: "provider_rate_limited", retryable: true };
  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
    return { code: "provider_unavailable", retryable: true };
  }
  if (statusCode !== undefined) return { code: "provider_invalid_response", retryable: false };

  const networkCodes = new Set([
    "ECONNABORTED",
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ]);
  if (networkCodes.has(findCode(error) ?? "")) {
    return { code: "provider_unavailable", retryable: true };
  }

  return { code: "provider_invalid_response", retryable: false };
}
