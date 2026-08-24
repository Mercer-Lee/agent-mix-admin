import { z } from "zod";
import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "./capability.registry";
import { defineCapability } from "./capability.types";

function createCapability(id = "users.search") {
  return defineCapability({
    manifest: {
      id,
      version: "1.0.0",
      module: "users",
      description: "Search users",
      risk: "read" as const,
      requiredPermissions: ["users:read"],
    },
    inputSchema: z.object({ search: z.string().optional() }),
    outputSchema: z.object({ total: z.number().int().min(0) }),
    execute: async () => ({ total: 0 }),
  });
}

describe("CapabilityRegistry", () => {
  it("registers capabilities and exposes serializable JSON schemas", () => {
    const registry = new CapabilityRegistry();

    const descriptor = registry.register(createCapability());

    expect(descriptor).toMatchObject({
      id: "users.search",
      version: "1.0.0",
      module: "users",
      requiredPermissions: ["users:read"],
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    });
    expect(registry.get("users.search")).toBeDefined();
    expect(registry.list()).toEqual([descriptor]);
  });

  it("rejects duplicate capability ids", () => {
    const registry = new CapabilityRegistry();
    registry.register(createCapability());

    expect(() => registry.register(createCapability())).toThrow(
      'Capability "users.search" is already registered',
    );
  });

  it("rejects invalid manifests", () => {
    const registry = new CapabilityRegistry();
    const invalid = createCapability();
    invalid.manifest = { ...invalid.manifest, id: "invalid" };

    expect(() => registry.register(invalid)).toThrow("capability id must use module.action format");
  });
});
