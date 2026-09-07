"use server";

import { revalidatePath } from "next/cache";
import { ServerApiError, serverApi } from "../../_lib/server-api";
import type { ModelCheckSummary, ModelProfile, ModelProfileMutationInput } from "./types";

interface ModelActionResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

function actionError(error: unknown): ModelActionResult<never> {
  if (error instanceof ServerApiError) {
    if (error.status === 403) return { ok: false, error: "Your account cannot change model governance." };
    if (error.status === 409) return { ok: false, error: "This model profile key is already in use." };
    if (error.status === 400) return { ok: false, error: `Invalid model profile: ${error.message}` };
  }
  return { ok: false, error: "The model control service is temporarily unavailable." };
}

function publicPayload(input: ModelProfileMutationInput, includeKey = false) {
  return {
    ...(includeKey && input.key ? { key: input.key } : {}),
    name: input.name,
    description: input.description,
    modelId: input.modelId,
    ...(input.status ? { status: input.status } : {}),
  };
}

export async function createModelAction(
  input: ModelProfileMutationInput,
): Promise<ModelActionResult<ModelProfile>> {
  try {
    const model = await serverApi<ModelProfile>("/models", {
      method: "POST",
      body: JSON.stringify(publicPayload(input, true)),
    });
    revalidatePath("/models");
    return { ok: true, data: model };
  } catch (error) {
    return actionError(error);
  }
}

export async function updateModelAction(
  modelId: string,
  input: ModelProfileMutationInput,
): Promise<ModelActionResult<ModelProfile>> {
  try {
    const model = await serverApi<ModelProfile>(`/models/${modelId}`, {
      method: "PUT",
      body: JSON.stringify(publicPayload(input)),
    });
    revalidatePath("/models");
    return { ok: true, data: model };
  } catch (error) {
    return actionError(error);
  }
}

export async function checkModelAction(modelId: string): Promise<ModelActionResult<ModelCheckSummary>> {
  try {
    const check = await serverApi<ModelCheckSummary>(`/models/${modelId}/check`, { method: "POST" });
    revalidatePath("/models");
    return { ok: true, data: check };
  } catch (error) {
    return actionError(error);
  }
}
