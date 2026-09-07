import { Transform } from "class-transformer";
import { IsIn, IsString, Length, MaxLength } from "class-validator";

export class UpdateAgentDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 120)
  name!: string;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(2000)
  description!: string;

  @IsIn(["active", "disabled"])
  status!: "active" | "disabled";

}
