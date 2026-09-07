export type ModelProfileStatus = "active" | "disabled";
export type ModelCheckStatus = "queued" | "running" | "succeeded" | "failed";

export interface ModelCheckSummary {
  id: string;
  status: ModelCheckStatus;
  latencyMs: number | null;
  errorCode: string | null;
  createdAt?: string;
  completedAt: string | null;
}

export interface ModelProfile {
  id: string;
  key: string;
  name: string;
  description: string;
  provider: "openai-compatible";
  connection: "default";
  modelId: string;
  status: ModelProfileStatus;
  lastCheck: ModelCheckSummary | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ModelProfileListResponse {
  items: ModelProfile[];
}

export interface ModelProfileMutationInput {
  key?: string;
  name: string;
  description: string;
  modelId: string;
  status?: ModelProfileStatus;
}

export interface ModelAccess {
  canCreate: boolean;
  canUpdate: boolean;
  canTest: boolean;
}
