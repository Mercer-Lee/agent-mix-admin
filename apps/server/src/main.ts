import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import type { Environment } from "./config/environment";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService<Environment, true>);
  app
    .getHttpAdapter()
    .getInstance()
    .set("trust proxy", config.get("TRUST_PROXY", { infer: true }));
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.enableCors({
    origin: config.get("ADMIN_ORIGIN", { infer: true }),
    credentials: true,
  });
  app.enableShutdownHooks();
  app.setGlobalPrefix("api");
  const port = config.get("SERVER_PORT", { infer: true });
  await app.listen(port);
  console.log(`[server] agentmix control-plane api listening on :${port}`);
}

void bootstrap();
