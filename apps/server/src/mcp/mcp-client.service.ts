import { Injectable, Logger, OnApplicationShutdown } from "@nestjs/common";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isValidJsonSchemaObject, type McpSyncErrorCode } from "./mcp.tooling";

const CONNECT_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 15_000;
const TOOL_CALL_TIMEOUT_MS = 30_000;

export interface McpEndpointConfig {
  /** Stable key for connection caching (the mcp_servers row id). */
  serverId: string;
  endpointUrl: string;
  authHeaderName: string | null;
  authEnvVar: string | null;
}

export interface McpDiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
}

/**
 * Safe failure taxonomy surfaced to admins. Never includes endpoint URLs,
 * headers, or remote error bodies — those can embed credentials or internal
 * topology.
 */
export class McpClientError extends Error {
  constructor(public readonly code: McpSyncErrorCode) {
    super(`MCP client operation failed: ${code}`);
    this.name = "McpClientError";
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, failure: McpSyncErrorCode): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new McpClientError(failure)), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

@Injectable()
export class McpClientService implements OnApplicationShutdown {
  private readonly logger = new Logger(McpClientService.name);
  private readonly clients = new Map<string, Promise<Client>>();

  async listTools(endpoint: McpEndpointConfig): Promise<McpDiscoveredTool[]> {
    const client = await this.connect(endpoint);
    try {
      const tools: McpDiscoveredTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await withTimeout(
          client.listTools(cursor ? { cursor } : undefined, {
            timeout: LIST_TIMEOUT_MS,
          }),
          LIST_TIMEOUT_MS,
          "TIMEOUT",
        );
        for (const tool of page.tools) {
          if (!isValidJsonSchemaObject(tool.inputSchema)) {
            throw new McpClientError("INVALID_INPUT_SCHEMA");
          }
          tools.push({
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : "",
            inputSchema: tool.inputSchema,
            outputSchema:
              tool.outputSchema && isValidJsonSchemaObject(tool.outputSchema)
                ? tool.outputSchema
                : null,
          });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return tools;
    } catch (error) {
      // Reached the server but failed to speak to it; only connect() reports
      // CONNECT_FAILED, so the admin sees which side actually broke.
      this.invalidate(endpoint.serverId);
      throw this.normalize(error, "PROTOCOL_ERROR");
    }
  }

  async callTool(
    endpoint: McpEndpointConfig,
    toolName: string,
    input: unknown,
  ): Promise<unknown> {
    const client = await this.connect(endpoint).catch((error: unknown) => {
      throw this.normalize(error, "CONNECT_FAILED");
    });
    try {
      const result = await withTimeout(
        client.callTool({ name: toolName, arguments: input as Record<string, unknown> }, undefined, {
          timeout: TOOL_CALL_TIMEOUT_MS,
        }),
        TOOL_CALL_TIMEOUT_MS + 1_000,
        "TIMEOUT",
      );
      if (result.isError) {
        throw new McpClientError("PROTOCOL_ERROR");
      }
      // Prefer the machine-readable result; fall back to the content blocks,
      // which are plain JSON-serializable objects per the MCP spec.
      if (result.structuredContent !== undefined) {
        return result.structuredContent;
      }
      return { content: result.content ?? [] };
    } catch (error) {
      this.invalidate(endpoint.serverId);
      throw this.normalize(error, "PROTOCOL_ERROR");
    }
  }

  invalidate(serverId: string): void {
    const entry = this.clients.get(serverId);
    this.clients.delete(serverId);
    if (!entry) return;
    void entry.then((client) => client.close()).catch(() => undefined);
  }

  async onApplicationShutdown(): Promise<void> {
    for (const serverId of [...this.clients.keys()]) {
      this.invalidate(serverId);
    }
  }

  private connect(endpoint: McpEndpointConfig): Promise<Client> {
    let entry = this.clients.get(endpoint.serverId);
    if (!entry) {
      entry = this.openClient(endpoint);
      this.clients.set(endpoint.serverId, entry);
      void entry.catch(() => {
        if (this.clients.get(endpoint.serverId) === entry) this.clients.delete(endpoint.serverId);
      });
    }
    return entry;
  }

  private async openClient(endpoint: McpEndpointConfig): Promise<Client> {
    const headers: Record<string, string> = {};
    if (endpoint.authHeaderName && endpoint.authEnvVar) {
      const secret = process.env[endpoint.authEnvVar];
      if (!secret) {
        // The env var name is configuration, not a credential; the value never
        // leaves the process. Surface only the stable code.
        throw new McpClientError("AUTH_ENV_MISSING");
      }
      headers[endpoint.authHeaderName] = secret;
    }
    let url: URL;
    try {
      url = new URL(endpoint.endpointUrl);
    } catch {
      throw new McpClientError("CONNECT_FAILED");
    }
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    });
    const client = new Client({ name: "agentmix-control-plane", version: "1.0.0" });
    try {
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "TIMEOUT");
    } catch (error) {
      void client.close().catch(() => undefined);
      throw this.normalize(error, "CONNECT_FAILED");
    }
    this.logger.debug(`MCP client connected for server ${endpoint.serverId}`);
    return client;
  }

  /**
   * Maps an arbitrary failure onto the safe error taxonomy. The caller supplies
   * the fallback because only it knows which phase failed: establishing a
   * connection or exchanging messages with an already connected server.
   */
  private normalize(error: unknown, fallback: McpSyncErrorCode): McpClientError {
    if (error instanceof McpClientError) return error;
    if (error instanceof Error && error.message === "TIMEOUT") return new McpClientError("TIMEOUT");
    return new McpClientError(fallback);
  }
}
