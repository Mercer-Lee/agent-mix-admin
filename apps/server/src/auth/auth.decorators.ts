import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "agentmix:is-public";
export const REQUIRED_PERMISSIONS_KEY = "agentmix:required-permissions";

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
