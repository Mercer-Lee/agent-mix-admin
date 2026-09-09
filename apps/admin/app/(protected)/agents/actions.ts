"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
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

type AgentActionResource = "agentProfile" | "agentRoles" | "agentPermissions" | "agentRuntime" | "agentAccess";

async function actionError(error: unknown, resource: AgentActionResource): Promise<AgentActionResult<never>> {
  const t = await getTranslations("agents.actions");
  if (error instanceof ServerApiError) {
    if (error.status === 403) {
      return { ok: false, error: t("forbidden", { resource: t(`resources.${resource}`) }) };
    }
    if (error.status === 409) return { ok: false, error: error.message };
    if (error.status === 400) return { ok: false, error: t("invalidRequest", { message: error.message }) };
  }
  return { ok: false, error: t("serviceUnavailable", { resource: t(`resources.${resource}`) }) };
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
    return await actionError(error, "agentProfile");
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
    return await actionError(error, "agentProfile");
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
    return await actionError(error, "agentRoles");
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
    return await actionError(error, "agentPermissions");
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
    return await actionError(error, "agentRuntime");
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
    return await actionError(error, "agentAccess");
  }
}
