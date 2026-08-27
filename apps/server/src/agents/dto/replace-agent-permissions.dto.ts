import { ArrayUnique, IsArray, IsUUID } from "class-validator";

export class ReplaceAgentPermissionsDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  permissionIds!: string[];
}
