import { Transform } from "class-transformer";
import { IsIn, IsString, Length, MaxLength } from "class-validator";

export class UpdateModelDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 120)
  name!: string;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(2_000)
  description!: string;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @Length(1, 200)
  modelId!: string;

  @IsIn(["active", "disabled"])
  status!: "active" | "disabled";
}
