import { Transform } from "class-transformer";
import { IsString, Length } from "class-validator";

export class CreateMessageDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 32_000)
  content!: string;
}
