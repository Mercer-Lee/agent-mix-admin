"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { ServerApiError, serverApi } from "../../_lib/server-api";
import type {
  McpServer,
  McpServerCreateInput,
  McpServerUpdateInput,
  McpSyncOutcome,
  McpToolMutationInput,
} from "./types";

interface ToolsActionResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function actionError(error: unknown): Promise<ToolsActionResult<never>> {
  const t = await getTranslations("tools.actions");
  if (error instanceof ServerApiError) {
    if (error.status === 403) return { ok: false, error: t("forbidden") };
    if (error.status === 409) return { ok: false, error: t("conflict") };
    if (error.status === 400) return { ok: false, error: t("invalid", { message: error.message }) };
    if (error.status === 404) return { ok: false, error: t("notFound") };
    if (error.status === 502) return { ok: false, error: t("syncFailed", { message: error.message }) };
  }
  return { ok: false, error: t("serviceUnavailable") };
}

export async function createServerAction(
  input: McpServerCreateInput,
): Promise<ToolsActionResult<McpServer>> {
  try {
    const server = await serverApi<McpServer>("/mcp/servers", {
      method: "POST",
      body: JSON.stringify(input),
    });
    revalidatePath("/tools");
    return { ok: true, data: server };
  } catch (error) {
    return await actionError(error);
  }
}

export async function updateServerAction(
  serverId: string,
  input: McpServerUpdateInput,
): Promise<ToolsActionResult<McpServer>> {
  try {
    const server = await serverApi<McpServer>(`/mcp/servers/${serverId}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
    revalidatePath("/tools");
    return { ok: true, data: server };
  } catch (error) {
    return await actionError(error);
  }
}

export async function deleteServerAction(serverId: string): Promise<ToolsActionResult<true>> {
  try {
    await serverApi(`/mcp/servers/${serverId}`, { method: "DELETE" });
    revalidatePath("/tools");
    return { ok: true, data: true };
  } catch (error) {
    return await actionError(error);
  }
}

export async function syncServerAction(serverId: string): Promise<ToolsActionResult<McpSyncOutcome>> {
  try {
    const outcome = await serverApi<McpSyncOutcome>(`/mcp/servers/${serverId}/sync`, {
      method: "POST",
    });
    revalidatePath("/tools");
    return { ok: true, data: outcome };
  } catch (error) {
    return await actionError(error);
  }
}

export async function updateToolAction(
  toolId: string,
  input: McpToolMutationInput,
): Promise<ToolsActionResult<true>> {
  try {
    await serverApi(`/mcp/tools/${toolId}`, { method: "PUT", body: JSON.stringify(input) });
    revalidatePath("/tools");
    return { ok: true, data: true };
  } catch (error) {
    return await actionError(error);
  }
}
