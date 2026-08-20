import { Body, Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import type { Environment } from "../config/environment";
import { AuthService } from "./auth.service";
import type { AuthenticatedRequest } from "./auth.types";
import { Public } from "./auth.decorators";
import { LoginDto } from "./dto/login.dto";
import { getRequestMetadata } from "./request-metadata";

export const SESSION_COOKIE = "agentmix_session";

@Controller("auth")
export class AuthController {
  private readonly secureCookie: boolean;

  constructor(
    private readonly auth: AuthService,
    configService: ConfigService<Environment, true>,
  ) {
    this.secureCookie = configService.get("NODE_ENV", { infer: true }) === "production";
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post("login")
  async login(@Body() dto: LoginDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.login(dto.username, dto.password, getRequestMetadata(request));
    response.cookie(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.secureCookie,
      path: "/",
      expires: result.expiresAt,
    });
    return result.context;
  }

  @Get("me")
  me(@Req() request: AuthenticatedRequest) {
    return request.auth.context;
  }

  @Public()
  @HttpCode(204)
  @Post("logout")
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.auth.logout(request.cookies?.[SESSION_COOKIE] as string | undefined, getRequestMetadata(request));
    response.clearCookie(SESSION_COOKIE, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.secureCookie,
      path: "/",
    });
  }
}
