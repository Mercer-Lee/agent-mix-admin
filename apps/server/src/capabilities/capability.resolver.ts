import { Injectable } from "@nestjs/common";
import { CapabilityRegistry } from "./capability.registry";
import { CapabilitySourceRegistry } from "./capability-source.registry";
import type { AnyRegisteredCapability } from "./capability.types";

/**
 * Resolves a capability id to the definition that is in force *now*.
 *
 * Two kinds of capability meet here:
 *
 * - Code-defined capabilities (users.search) live only in the registry.
 * - Database-defined capabilities (MCP tools) have a source, and the source is
 *   their authority. The registry is kept as the enumeration surface
 *   (`listAvailable` builds the model-facing tool set from it), but a source's
 *   definition is re-read and re-published on every request. Authorizing against
 *   a cached manifest would fail open: `CapabilityExecutor` checks
 *   `manifest.requiredPermissions`, so an entry cached before an admin tightened
 *   or disabled a tool would keep executing with the older, weaker set — and no
 *   local mutation can invalidate a cache held by another replica.
 *
 * The cost is a pair of catalog reads per capability call (enabled tools joined
 * with active servers, plus the permission catalog) — unindexed but small, next
 * to the model turn each lookup feeds.
 */
@Injectable()
export class CapabilityResolver {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly sources: CapabilitySourceRegistry,
  ) {}

  async resolve(capabilityId: string): Promise<AnyRegisteredCapability | undefined> {
    const loaded = await this.sources.load(capabilityId);
    if (loaded) {
      // Keep the enumeration surface aligned with the row just read.
      this.registry.upsert(loaded.definition, loaded.schemas);
      return this.registry.get(capabilityId);
    }
    // A source may own this id and still refuse it (disabled tool, tightened
    // permissions). That refusal is final: falling back to a cached entry would
    // execute exactly what the source just declined.
    if (await this.sources.claims(capabilityId)) return undefined;
    return this.registry.get(capabilityId);
  }
}
