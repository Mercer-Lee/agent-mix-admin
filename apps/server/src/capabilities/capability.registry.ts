import { Injectable } from "@nestjs/common";
import {
  CapabilityManifestSchema,
  type CapabilityDescriptor,
} from "@agentmix/core";
import { z } from "zod";
import type { AnyRegisteredCapability } from "./capability.types";

interface RegistryEntry {
  definition: AnyRegisteredCapability;
  descriptor: CapabilityDescriptor;
}

export interface CapabilitySchemaOverride {
  /**
   * Precomputed JSON Schemas for capabilities whose validation is not
   * representable as a Zod schema (registered MCP tools validate with Ajv
   * against the schema advertised by the MCP server). The Zod schemas on the
   * definition still enforce the values at execution time.
   */
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

/** Identifies whoever registered a capability, for ownership-safe removal. */
export interface CapabilityOwner {
  module: string;
}

function capabilityOwnedBy(entry: RegistryEntry, owner: CapabilityOwner): boolean {
  return entry.descriptor.module === owner.module;
}

@Injectable()
export class CapabilityRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  register(
    definition: AnyRegisteredCapability,
    schemas?: CapabilitySchemaOverride,
  ): CapabilityDescriptor {
    const manifest = CapabilityManifestSchema.parse(definition.manifest);
    if (this.entries.has(manifest.id)) {
      throw new Error(`Capability "${manifest.id}" is already registered`);
    }

    const normalizedDefinition = { ...definition, manifest };
    const descriptor: CapabilityDescriptor = {
      ...manifest,
      inputSchema:
        schemas?.inputSchema ?? (z.toJSONSchema(definition.inputSchema) as Record<string, unknown>),
      outputSchema:
        schemas?.outputSchema ??
        (z.toJSONSchema(definition.outputSchema) as Record<string, unknown>),
    };
    this.entries.set(manifest.id, { definition: normalizedDefinition, descriptor });
    return descriptor;
  }

  /**
   * Removes a capability only when `owner` still matches the registered entry.
   * Registrations live in process memory while their source of truth is the
   * database, so a stale caller (an MCP server that lost a registration race,
   * a slug that was re-registered) must not be able to evict another owner's
   * live capability.
   */
  unregister(id: string, owner?: CapabilityOwner): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    if (owner && !capabilityOwnedBy(entry, owner)) return false;
    return this.entries.delete(id);
  }

  get(id: string): AnyRegisteredCapability | undefined {
    return this.entries.get(id)?.definition;
  }

  list(): CapabilityDescriptor[] {
    return [...this.entries.values()]
      .map((entry) => entry.descriptor)
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}
