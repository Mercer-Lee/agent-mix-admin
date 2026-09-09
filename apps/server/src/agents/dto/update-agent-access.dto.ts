import { Type } from "class-transformer";
import { ArrayUnique, IsArray, IsBoolean, IsUUID, ValidateNested } from "class-validator";

export class DepartmentAccessGrantDto {
  @IsUUID()
  departmentId!: string;

  @IsBoolean()
  includeDescendants!: boolean;
}

export class UpdateAgentAccessDto {
  @IsArray()
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  userIds!: string[];

  @IsArray()
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  roleIds!: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DepartmentAccessGrantDto)
  departments!: DepartmentAccessGrantDto[];
}
