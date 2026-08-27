import "server-only";

import { cookies } from "next/headers";

export class ServerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ServerApiError";
  }
}

interface ErrorResponse {
  message?: string | string[];
}

export async function serverApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cookieStore = await cookies();
  const method = init.method?.toUpperCase() ?? "GET";
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("cookie", cookieStore.toString());
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("origin", process.env.ADMIN_ORIGIN ?? "http://localhost:3100");
  }

  const response = await fetch(
    `${process.env.SERVER_INTERNAL_URL ?? "http://localhost:3101"}/api${path}`,
    { ...init, headers, cache: "no-store" },
  );
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  let message = `API request failed with status ${response.status}`;
  try {
    const error = (await response.json()) as ErrorResponse;
    if (Array.isArray(error.message)) message = error.message.join("; ");
    else if (error.message) message = error.message;
  } catch {
    // Keep the status-only fallback for non-JSON upstream failures.
  }
  throw new ServerApiError(response.status, message);
}
