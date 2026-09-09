import { Transform } from "class-transformer";
import { IsString, IsUUID, Length } from "class-validator";

export class CreateConversationDto {
  @IsUUID()
  agentId!: string;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 32_000)
  content!: string;
}
