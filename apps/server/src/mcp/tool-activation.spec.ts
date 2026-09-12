import { describe, expect, it } from "vitest";
import { resolveToolActivationState, type ToolActivationFacts } from "./mcp.service";

/** Every precondition satisfied and the capability registered. */
function facts(overrides: Partial<ToolActivationFacts> = {}): ToolActivationFacts {
  return {
    serverStatus: "active",
    enabled: true,
    capabilityId: "mcp-docs.search_docs",
    requiredPermissions: ["users:read"],
    knownPermissions: new Set(["users:read"]),
    registered: true,
    ...overrides,
  };
}

describe("MCP tool activation state", () => {
  it("reports a registered tool as usable", () => {
    expect(resolveToolActivationState(facts())).toBe("registered");
  });

  it("treats the admin switch and the server status as their own states", () => {
    expect(resolveToolActivationState(facts({ enabled: false }))).toBe("disabled");
    expect(resolveToolActivationState(facts({ serverStatus: "disabled" }))).toBe(
      "server_disabled",
    );
  });

  it("reports a tool name that cannot form a capability id", () => {
    expect(
      resolveToolActivationState(facts({ capabilityId: null, registered: false })),
    ).toBe("invalid_capability_id");
  });

  it("reports missing and stale required permissions", () => {
    expect(
      resolveToolActivationState(
        facts({ requiredPermissions: [], registered: false }),
      ),
    ).toBe("permissions_required");
    expect(
      resolveToolActivationState(
        facts({ requiredPermissions: ["legacy:read"], registered: false }),
      ),
    ).toBe("unknown_permissions");
  });

  it("reports a tool this instance has not loaded as pending, not usable", () => {
    // Every precondition holds, but the registry here does not hold it yet. The
    // executor resolves that on demand, so it is pending rather than broken —
    // and it must never be reported as registered when it is not loaded.
    expect(resolveToolActivationState(facts({ registered: false }))).toBe(
      "registration_pending",
    );
  });

  it("never reports an uncallable tool as registered", () => {
    // Exhaustive guard over the preconditions: dropping any one of them must
    // move the state off "registered".
    const broken: Array<Partial<ToolActivationFacts>> = [
      { enabled: false },
      { serverStatus: "disabled" },
      { capabilityId: null },
      { requiredPermissions: [] },
      { requiredPermissions: ["legacy:read"] },
      { registered: false },
    ];
    for (const override of broken) {
      expect(resolveToolActivationState(facts(override))).not.toBe("registered");
    }
  });
});
