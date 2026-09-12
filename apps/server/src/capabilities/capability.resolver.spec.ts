import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityRegistry } from "./capability.registry";
import { CapabilityResolver } from "./capability.resolver";
import { CapabilitySourceRegistry } from "./capability-source.registry";
import type { CapabilitySource } from "./capability.source";
import { defineCapability } from "./capability.types";

const SECRET_INPUT = { search: z.string().optional() };

function definition(id = "mcp-docs.search_docs", description = "Search the handbook.") {
  return defineCapability({
    manifest: {
      id,
      version: "1.0.0",
      module: "mcp-docs",
      description,
      risk: "read" as const,
      requiredPermissions: ["users:read"],
    },
    inputSchema: z.object(SECRET_INPUT),
    outputSchema: z.object({ ok: z.boolean() }),
    execute: async () => ({ ok: true }),
  });
}

describe("CapabilityResolver", () => {
  let registry: CapabilityRegistry;
  let sources: CapabilitySourceRegistry;
  let load: ReturnType<typeof vi.fn>;
  let source: CapabilitySource;

  beforeEach(() => {
    registry = new CapabilityRegistry();
    sources = new CapabilitySourceRegistry();
    load = vi.fn().mockResolvedValue({
      definition: definition("mcp-docs.search_docs", "Search the handbook (v2)."),
      schemas: { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
    });
    source = { load, claims: vi.fn().mockResolvedValue(true) } as unknown as CapabilitySource;
    sources.register(source);
  });

  it("resolves a capability this instance never registered", async () => {
    // The situation the source exists for: the shared capability queue handed
    // this instance a request for a tool a different replica registered.
    const resolver = new CapabilityResolver(registry, sources);

    await expect(resolver.resolve("mcp-docs.search_docs")).resolves.toMatchObject({
      manifest: { id: "mcp-docs.search_docs" },
    });
    expect(load).toHaveBeenCalledWith("mcp-docs.search_docs");
    // Published into the registry so the model-facing enumeration sees it too.
    expect(registry.get("mcp-docs.search_docs")).toBeDefined();
  });

  it("authorizes against the current row, not a definition cached earlier", async () => {
    // Execution checks manifest.requiredPermissions, so the definition in force
    // must be the stored row, not the one this process cached when it booted.
    const resolver = new CapabilityResolver(registry, sources);
    await expect(resolver.resolve("mcp-docs.search_docs")).resolves.toMatchObject({
      manifest: { requiredPermissions: ["users:read"] },
    });

    const tightened = definition("mcp-docs.search_docs", "Search the handbook (v2).");
    tightened.manifest = { ...tightened.manifest, requiredPermissions: ["users:read", "users:manage"] };
    load.mockResolvedValueOnce({
      definition: tightened,
      schemas: { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
    });
    await expect(resolver.resolve("mcp-docs.search_docs")).resolves.toMatchObject({
      manifest: { requiredPermissions: ["users:read", "users:manage"] },
    });
  });

  it("keeps serving registry-only capabilities the source does not claim", async () => {
    // users.search has no source. A source declining an id it does not own must
    // not shadow the registration.
    registry.register(definition("users.search", "Search governed users."));
    load.mockResolvedValue(null);
    (source.claims as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const resolver = new CapabilityResolver(registry, sources);

    await expect(resolver.resolve("users.search")).resolves.toMatchObject({
      manifest: { id: "users.search" },
    });
  });

  it("refuses an id its source owns but declines, despite a cached registration", async () => {
    // The fail-open case: this instance cached the tool earlier, then the admin
    // disabled it. The source owns the id and says no, which must end the matter
    // rather than fall back to the cached (now unauthorized) definition.
    const resolver = new CapabilityResolver(registry, sources);
    await expect(resolver.resolve("mcp-docs.search_docs")).resolves.toBeDefined();

    load.mockResolvedValue(null);
    await expect(resolver.resolve("mcp-docs.search_docs")).resolves.toBeUndefined();
  });

  it("reports an unknown capability as unresolved when the source has nothing", async () => {
    load.mockResolvedValue(null);
    const resolver = new CapabilityResolver(registry, sources);

    await expect(resolver.resolve("mcp-docs.nope")).resolves.toBeUndefined();
    await expect(resolver.resolve("mcp-docs.nope")).resolves.toBeUndefined();
  });

  it("serves a capability with no source registered", async () => {
    const resolver = new CapabilityResolver(registry, new CapabilitySourceRegistry());
    await expect(resolver.resolve("mcp-docs.search_docs")).resolves.toBeUndefined();
  });

  it("returns the winning definition when two requests race the same id", async () => {
    // Both requests miss, both load, both try to register: the loser must not
    // surface an error, and both callers must get a usable definition.
    const resolver = new CapabilityResolver(registry, sources);
    const [first, second] = await Promise.all([
      resolver.resolve("mcp-docs.search_docs"),
      resolver.resolve("mcp-docs.search_docs"),
    ]);

    expect(first?.manifest.id).toBe("mcp-docs.search_docs");
    expect(second?.manifest.id).toBe("mcp-docs.search_docs");
  });

  it("republishes the freshly loaded definition over an older registration", async () => {
    // A description or permission change is how an admin edit shows up; the
    // registry entry must follow the row rather than keep the boot-time copy.
    registry.register(definition("mcp-docs.search_docs", "Search the handbook."));
    const resolver = new CapabilityResolver(registry, sources);

    await expect(resolver.resolve("mcp-docs.search_docs")).resolves.toMatchObject({
      manifest: { description: "Search the handbook (v2)." },
    });
    expect(registry.get("mcp-docs.search_docs")?.manifest.description).toBe(
      "Search the handbook (v2).",
    );
    // The enumeration surface carries the same freshness.
    expect(registry.list().find((item) => item.id === "mcp-docs.search_docs")?.description).toBe(
      "Search the handbook (v2).",
    );
  });
});
