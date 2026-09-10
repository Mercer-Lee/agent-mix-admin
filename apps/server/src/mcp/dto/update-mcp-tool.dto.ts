import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
} from "class-validator";

export class UpdateMcpToolDto {
  @IsOptional()
  @IsIn(["read", "sensitive_read", "write", "critical"])
  risk?: "read" | "sensitive_read" | "write" | "critical";

  @IsOptional()
  @Transform(({ value }) => (Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v.trim() : v)) : value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @IsString({ each: true })
  @Matches(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/, { each: true })
  requiredPermissions?: string[];

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  enabled?: boolean;
}
