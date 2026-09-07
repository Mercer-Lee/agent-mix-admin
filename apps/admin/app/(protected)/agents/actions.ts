"use server";

import { revalidatePath } from "next/cache";
import { ServerApiError, serverApi } from "../../_lib/server-api";
import type {
  AgentDetail,
  AgentInvocationAccess,
  AgentInvocationAccessInput,
  AgentProfileMutationInput,
  AgentRuntime,
  AgentRuntimeMutationInput,
} from "./types";

export interface AgentActionResult<T = AgentDetail> {
  ok: boolean;
  data?: T;
  error?: string;
}

function actionError(error: unknown, resource: string): AgentActionResult<never> {
  if (error instanceof ServerApiError) {
    if (error.status === 403) return { ok: false, error: `Your account cannot update ${resource}.` };
    if (error.status === 409) return { ok: false, error: error.message };
    if (error.status === 400) return { ok: false, error: `Invalid request: ${error.message}` };
  }
  return { ok: false, error: `The ${resource} service is temporarily unavailable.` };
}

export async function createAgentAction(
  input: AgentProfileMutationInput,
): Promise<AgentActionResult<AgentDetail>> {
  try {
    const agent = await serverApi<AgentDetail>("/agents", {
      method: "POST",
      body: JSON.stringify({
        slug: input.slug,
        name: input.name,
        description: input.description,
      }),
    });
    revalidatePath("/agents");
    return { ok: true, data: agent };
  } catch (error) {
    return actionError(error, "agent profile");
  }
}

export async function updateAgentProfileAction(
  agentId: string,
  input: AgentProfileMutationInput,
): Promise<AgentActionResult<AgentDetail>> {
  try {
    const agent = await serverApi<AgentDetail>(`/agents/${agentId}`, {
      method: "PUT",
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        status: input.status,
      }),
    });
    revalidatePath("/agents");
    return { ok: true, data: agent };
  } catch (error) {
    return actionError(error, "agent profile");
  }
}

export async function updateAgentRolesAction(
  agentId: string,
  roleIds: string[],
): Promise<AgentActionResult<void>> {
  try {
    await serverApi<void>(`/agents/${agentId}/roles`, {
      method: "PUT",
      body: JSON.stringify({ roleIds }),
    });
    revalidatePath("/agents");
    return { ok: true };
  } catch (error) {
    return actionError(error, "agent role assignments");
  }
}

export async function updateAgentPermissionsAction(
  agentId: string,
  permissionIds: string[],
): Promise<AgentActionResult<void>> {
  try {
    await serverApi<void>(`/agents/${agentId}/permissions`, {
      method: "PUT",
      body: JSON.stringify({ permissionIds }),
    });
    revalidatePath("/agents");
    return { ok: true };
  } catch (error) {
    return actionError(error, "agent direct permissions");
  }
}

export async function updateAgentRuntimeAction(
  agentId: string,
  input: AgentRuntimeMutationInput,
): Promise<AgentActionResult<AgentRuntime>> {
  try {
    const runtime = await serverApi<AgentRuntime>(`/agents/${agentId}/runtime`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
    revalidatePath("/agents");
    return { ok: true, data: runtime };
  } catch (error) {
    return actionError(error, "agent runtime");
  }
}

export async function updateAgentAccessAction(
  agentId: string,
  input: AgentInvocationAccessInput,
): Promise<AgentActionResult<AgentInvocationAccess>> {
  try {
    const access = await serverApi<AgentInvocationAccess>(`/agents/${agentId}/access`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
    revalidatePath("/agents");
    revalidatePath("/chat");
    return { ok: true, data: access };
  } catch (error) {
    return actionError(error, "agent invocation access");
  }
}
