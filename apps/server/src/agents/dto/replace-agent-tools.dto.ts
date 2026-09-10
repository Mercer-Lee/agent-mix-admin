import { AGENT_RUN_MAX_TOOLS } from "@agentmix/core";
import { Transform } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from "class-validator";

/**
 * A binding set may never exceed what one run snapshot can carry, so a bound
 * tool can't silently disappear from the model-facing tool set. The internal
 * users.search vertical also occupies a snapshot slot, hence the -1 reserved
 * when the agent has that capability; AGENT_RUN_MAX_TOOLS is the hard ceiling.
 */
const MAX_BOUND_TOOLS = AGENT_RUN_MAX_TOOLS - 1;

export class ReplaceAgentToolsDto {
  @Transform(({ value }) => (Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v.trim() : v)) : value))
  @IsArray()
  @ArrayMinSize(0)
  @ArrayMaxSize(MAX_BOUND_TOOLS)
  @IsUUID("4", { each: true })
  toolIds!: string[];
}
