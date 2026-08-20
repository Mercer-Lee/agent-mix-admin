import { Transform } from "class-transformer";
import { IsString, Length, Matches } from "class-validator";

export class LoginDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toLowerCase() : value))
  @IsString()
  @Matches(/^[a-z0-9._-]+$/)
  @Length(3, 32)
  username!: string;

  @IsString()
  @Length(12, 128)
  password!: string;
}
