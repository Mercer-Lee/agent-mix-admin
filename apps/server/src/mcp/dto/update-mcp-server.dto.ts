import { Transform } from "class-transformer";
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from "class-validator";

/**
 * Patch-like semantics over PUT: an omitted field keeps its stored value, and
 * the auth pair can only be *replaced* (both names together) or *cleared*
 * (clearAuth). Null is deliberately rejected for the auth fields so a client
 * that serializes every optional field as null cannot silently strip a
 * server's credentials.
 *
 * The slug is absent on purpose: it is the server's stable public identity —
 * capability ids (`mcp-<slug>.<tool>`), audit resource ids and registry module
 * ownership are all derived from it, so changing it would orphan live
 * registrations. Re-register under the new slug instead.
 */
export class UpdateMcpServerDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(2_000)
  description?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Matches(/^https?:\/\/\S{1,2000}$/i, { message: "endpointUrl must be an http(s) URL" })
  endpointUrl?: string;

  /**
   * ValidateIf rather than IsOptional: IsOptional also skips validation for an
   * explicit null, so a client that serializes every optional field as null
   * would be accepted and strip the pair. Only an absent field means "keep".
   */
  @ValidateIf((_dto, value) => value !== undefined)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString({ message: "authHeaderName must be a string; omit it to keep the stored value" })
  @IsNotEmpty({ message: "authHeaderName must not be empty; use clearAuth to remove the pair" })
  @Matches(/^[A-Za-z0-9-]{1,100}$/)
  authHeaderName?: string;

  @ValidateIf((_dto, value) => value !== undefined)
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString({ message: "authEnvVar must be a string; omit it to keep the stored value" })
  @IsNotEmpty({ message: "authEnvVar must not be empty; use clearAuth to remove the pair" })
  @Matches(/^[A-Z][A-Z0-9_]*$/)
  authEnvVar?: string;

  /** Explicit removal of the stored credential pair. */
  @IsOptional()
  @IsBoolean()
  clearAuth?: boolean;

  @IsOptional()
  @IsIn(["active", "disabled"])
  status?: "active" | "disabled";
}
