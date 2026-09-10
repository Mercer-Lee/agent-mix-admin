import type { AppConfig } from "next-intl";
import type agents from "../messages/en/agents.json";
import type audit from "../messages/en/audit.json";
import type chat from "../messages/en/chat.json";
import type common from "../messages/en/common.json";
import type models from "../messages/en/models.json";
import type tools from "../messages/en/tools.json";

declare global {
  interface AppConfig {
    Messages: typeof common & {
      agents: typeof agents;
      models: typeof models;
      tools: typeof tools;
      audit: typeof audit;
      chat: typeof chat;
    };
  }
}

export {};
