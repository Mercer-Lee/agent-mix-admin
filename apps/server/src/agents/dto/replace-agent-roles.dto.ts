import { ArrayUnique, IsArray, IsUUID } from "class-validator";

export class ReplaceAgentRolesDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  roleIds!: string[];
}
