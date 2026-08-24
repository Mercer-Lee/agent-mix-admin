import { ArrayUnique, IsArray, IsUUID } from "class-validator";

export class ReplaceUserRolesDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  roleIds!: string[];
}
