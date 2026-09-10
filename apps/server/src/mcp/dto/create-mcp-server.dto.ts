import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, Length, Matches, MaxLength } from "class-validator";

export class CreateMcpServerDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/)
  slug!: string;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(2_000)
  description = "";

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Matches(/^https?:\/\/\S{1,2000}$/i, { message: "endpointUrl must be an http(s) URL" })
  endpointUrl!: string;

  /** Optional static auth header; the value comes from authEnvVar at connect time. */
  @IsOptional()
  @Matches(/^[A-Za-z0-9-]{1,100}$/)
  authHeaderName?: string | null;

  /** Name of the environment variable holding the auth secret — never the secret itself. */
  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9_]*$/)
  authEnvVar?: string | null;

  @IsOptional()
  @IsIn(["active", "disabled"])
  status: "active" | "disabled" = "active";
}
