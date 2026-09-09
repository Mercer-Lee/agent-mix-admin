import { redirect } from "next/navigation";
import { getAuthContext } from "../../_lib/auth";
import { serverApi } from "../../_lib/server-api";
import { ModelsManager } from "./models-manager";
import type { ModelProfile, ModelProfileListResponse } from "./types";

export default async function ModelsPage() {
  const auth = await getAuthContext();
  if (!auth?.permissions.includes("models:read")) redirect("/");

  const response = await serverApi<ModelProfileListResponse | ModelProfile[]>("/models");
  const models = Array.isArray(response) ? { items: response } : response;

  return (
    <ModelsManager
      initialData={models}
      access={{
        canCreate: auth.permissions.includes("models:create"),
        canUpdate: auth.permissions.includes("models:update"),
        canTest: auth.permissions.includes("models:test"),
      }}
    />
  );
}
