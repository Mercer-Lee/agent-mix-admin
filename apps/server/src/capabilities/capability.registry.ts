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

@Injectable()
export class CapabilityRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  register(definition: AnyRegisteredCapability): CapabilityDescriptor {
    const manifest = CapabilityManifestSchema.parse(definition.manifest);
    if (this.entries.has(manifest.id)) {
      throw new Error(`Capability "${manifest.id}" is already registered`);
    }

    const normalizedDefinition = { ...definition, manifest };
    const descriptor: CapabilityDescriptor = {
      ...manifest,
      inputSchema: z.toJSONSchema(definition.inputSchema) as Record<string, unknown>,
      outputSchema: z.toJSONSchema(definition.outputSchema) as Record<string, unknown>,
    };
    this.entries.set(manifest.id, { definition: normalizedDefinition, descriptor });
    return descriptor;
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
