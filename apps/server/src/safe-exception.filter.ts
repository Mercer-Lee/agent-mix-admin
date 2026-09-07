import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Request, Response } from "express";

/**
 * Keep infrastructure errors and their query parameters out of process logs
 * and HTTP responses. Explicit HttpExceptions are application-authored and
 * may retain their existing, user-safe response payloads.
 */
@Catch()
@Injectable()
export class SafeExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SafeExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();

    if (response.headersSent) {
      response.end();
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      response.status(status).json(
        typeof payload === "string" ? { statusCode: status, message: payload } : payload,
      );
      return;
    }

    const request = http.getRequest<Request>();
    const method = request.method?.toUpperCase() || "UNKNOWN";
    this.logger.error(`Unhandled ${method} request`);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: "Internal server error",
    });
  }
}
