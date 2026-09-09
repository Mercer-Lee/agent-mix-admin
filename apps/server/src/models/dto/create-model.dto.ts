import { Transform } from "class-transformer";
import { IsIn, IsOptional, IsString, Length, Matches, MaxLength } from "class-validator";

export class CreateModelDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{1,62}[a-z0-9]$/)
  key!: string;

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
  @Length(1, 200)
  modelId!: string;

  @IsOptional()
  @IsIn(["active", "disabled"])
  status: "active" | "disabled" = "active";
}
