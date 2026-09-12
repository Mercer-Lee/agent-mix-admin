import { Injectable } from "@nestjs/common";
import type { CapabilitySource } from "./capability.source";

/**
 * Holds the lazily-queryable capability sources for this process.
 *
 * Registration happens at runtime rather than through constructor injection on
 * purpose: a source lives in the module that owns the capability (mcp), which
 * imports the capabilities module to reach the registry. Injecting it back would
 * be a cycle, and Nest cannot resolve a token provided by a module that imports
 * the consumer — an `@Optional() @Inject(...)` there fails silently and yields
 * undefined, which is exactly how lazy loading would break without anyone
 * noticing.
 */
@Injectable()
export class CapabilitySourceRegistry {
  private readonly sources: CapabilitySource[] = [];

  register(source: CapabilitySource): void {
    if (this.sources.includes(source)) return;
    this.sources.push(source);
  }

  /**
   * First source that can build the capability wins. Sources are independent
   * capability owners, so an id belongs to exactly one of them.
   */
  async load(capabilityId: string) {
    for (const source of this.sources) {
      const loaded = await source.load(capabilityId);
      if (loaded) return loaded;
    }
    return null;
  }

  /** Whether any source owns this id, even if it is not callable right now. */
  async claims(capabilityId: string): Promise<boolean> {
    for (const source of this.sources) {
      if (await source.claims(capabilityId)) return true;
    }
    return false;
  }
}
