"use server";

import { revalidatePath } from "next/cache";
import { ServerApiError, serverApi } from "../../_lib/server-api";
import type { AgentDetail, AgentMutationInput } from "./types";

export interface AgentActionResult {
  ok: boolean;
  agent?: AgentDetail;
  error?: string;
}

function actionError(error: unknown): AgentActionResult {
  if (error instanceof ServerApiError) {
    if (error.status === 403) return { ok: false, error: "Your account cannot perform this operation." };
    if (error.status === 409) return { ok: false, error: "This agent slug is already in use." };
    if (error.status === 400) return { ok: false, error: `Invalid request: ${error.message}` };
  }
  return { ok: false, error: "The agent service is temporarily unavailable." };
}

export async function createAgentAction(input: AgentMutationInput): Promise<AgentActionResult> {
  try {
    const agent = await serverApi<AgentDetail>("/agents", {
      method: "POST",
      body: JSON.stringify({
        slug: input.slug,
        name: input.name,
        description: input.description,
        roleIds: input.roleIds,
        permissionIds: input.permissionIds,
      }),
    });
    revalidatePath("/agents");
    return { ok: true, agent };
  } catch (error) {
    return actionError(error);
  }
}

export async function updateAgentAction(
  agentId: string,
  input: AgentMutationInput,
): Promise<AgentActionResult> {
  try {
    const agent = await serverApi<AgentDetail>(`/agents/${agentId}`, {
      method: "PUT",
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        status: input.status,
        roleIds: input.roleIds,
        permissionIds: input.permissionIds,
      }),
    });
    revalidatePath("/agents");
    return { ok: true, agent };
  } catch (error) {
    return actionError(error);
  }
}
