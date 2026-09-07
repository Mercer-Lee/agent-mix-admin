import { Transform, Type } from "class-transformer";
import { IsInt, IsString, IsUUID, Max, MaxLength, Min } from "class-validator";

export class UpdateAgentRuntimeDto {
  @IsUUID()
  modelProfileId!: string;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(32_000)
  systemPrompt!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(32_768)
  maxOutputTokens = 2_048;
}
