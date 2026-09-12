import type { CapabilitySchemaOverride } from "./capability.registry";
import type { AnyRegisteredCapability } from "./capability.types";

/** DI token a capability-owning module provides to plug in lazy loading. */
export const CAPABILITY_SOURCE = "CAPABILITY_SOURCE";

/**
 * A lazily queryable source of capability definitions.
 *
 * The registry is per-process state, while capability requests are consumed from
 * a shared queue by whichever instance picks them up. A request can therefore
 * land on an instance that never registered the capability — one that booted
 * before the tool was enabled, or simply a different replica. Without a
 * source, that instance fails the call with CAPABILITY_NOT_FOUND even though the
 * tool exists; with one, it loads the definition from the database at call time
 * and serves the request identically to every other instance.
 *
 * Implementations must treat the database as the source of truth and return a
 * definition built from a fresh read: the returned `execute` closure must not
 * capture configuration that an admin may have changed since this instance
 * booted (endpoint URL, credentials, risk, required permissions).
 */
export interface CapabilitySource {
  /**
   * Build the capability with this governed id, or return null when it exists
   * but is not currently callable (server disabled, tool disabled, permissions
   * unknown). Returning null is a normal outcome, not an error.
   */
  load(
    capabilityId: string,
  ): Promise<{ definition: AnyRegisteredCapability; schemas: CapabilitySchemaOverride } | null>;

  /**
   * Whether this source owns the id at all, regardless of current callability.
   *
   * Without this, a source that answers "not callable right now" is
   * indistinguishable from a source that has never heard of the id, and the
   * resolver falls back to a registration cached earlier — which would keep
   * executing a tool the admin just disabled. Claiming the id makes the source's
   * answer final.
   */
  claims(capabilityId: string): Promise<boolean>;
}
