"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { ServerApiError, serverApi } from "../../_lib/server-api";
import type { CreateConversationResponse, CreateRunResponse } from "./types";

interface ChatActionResult<T = undefined> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function actionError(error: unknown): Promise<ChatActionResult<never>> {
  const t = await getTranslations("chat.actions");
  if (error instanceof ServerApiError) {
    if (error.status === 403) return { ok: false, error: t("forbidden") };
    if (error.status === 404) return { ok: false, error: t("unavailable") };
    if (error.status === 409) return { ok: false, error: error.message };
    if (error.status === 400) return { ok: false, error: t("invalidMessage", { message: error.message }) };
  }
  return { ok: false, error: t("serviceUnavailable") };
}

export async function createConversationAction(input: {
  agentId: string;
  content: string;
  idempotencyKey: string;
}): Promise<ChatActionResult<CreateConversationResponse>> {
  try {
    const response = await serverApi<CreateConversationResponse>("/conversations", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({ agentId: input.agentId, content: input.content }),
    });
    revalidatePath("/chat");
    return { ok: true, data: response };
  } catch (error) {
    return await actionError(error);
  }
}

export async function sendConversationMessageAction(input: {
  conversationId: string;
  content: string;
  idempotencyKey: string;
}): Promise<ChatActionResult<CreateRunResponse>> {
  try {
    const response = await serverApi<CreateRunResponse>(`/conversations/${input.conversationId}/messages`, {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({ content: input.content }),
    });
    revalidatePath(`/chat/${input.conversationId}`);
    return { ok: true, data: response };
  } catch (error) {
    return await actionError(error);
  }
}

export async function cancelRunAction(runId: string): Promise<ChatActionResult> {
  try {
    await serverApi<void>(`/runs/${runId}/cancel`, { method: "POST" });
    return { ok: true };
  } catch (error) {
    return await actionError(error);
  }
}

export async function deleteConversationAction(conversationId: string): Promise<ChatActionResult> {
  try {
    await serverApi<void>(`/conversations/${conversationId}`, { method: "DELETE" });
    revalidatePath("/chat");
    revalidatePath(`/chat/${conversationId}`);
    return { ok: true };
  } catch (error) {
    return await actionError(error);
  }
}
