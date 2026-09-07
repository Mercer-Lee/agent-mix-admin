import { BadRequestException, Logger, type ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { SafeExceptionFilter } from "./safe-exception.filter";

function createHost() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method: "POST" }),
      getResponse: () => ({ status }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe("SafeExceptionFilter", () => {
  it("replaces unknown infrastructure errors without logging their message or params", () => {
    const logger = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const response = createHost();

    new SafeExceptionFilter().catch(
      new Error("Failed query params: SECRET_PROMPT SECRET_SYSTEM_PROMPT"),
      response.host,
    );

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 500,
      message: "Internal server error",
    });
    expect(JSON.stringify(logger.mock.calls)).not.toContain("SECRET_PROMPT");
    expect(JSON.stringify(logger.mock.calls)).not.toContain("SECRET_SYSTEM_PROMPT");
    logger.mockRestore();
  });

  it("preserves explicit application HttpException responses", () => {
    const response = createHost();

    new SafeExceptionFilter().catch(new BadRequestException("Invalid request"), response.host);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: "Invalid request" }),
    );
  });
});
