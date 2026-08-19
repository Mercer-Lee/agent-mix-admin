import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true });
  app.setGlobalPrefix("api");
  const port = Number(process.env.SERVER_PORT ?? 3101);
  await app.listen(port);
  console.log(`[server] agentmix control-plane api listening on :${port}`);
}

void bootstrap();
