import { describe, expect, it } from "vitest";
import {
  claimsMcpCapabilityNamespace,
  createJsonSchemaValidator,
  deriveMcpCapabilityId,
  deriveMcpModule,
  isValidJsonSchemaObject,
  jsonValueSchema,
  validateDiscoveredToolName,
} from "./mcp.tooling";

describe("MCP capability id derivation", () => {
  it("derives a governed capability id from the server slug and tool name", () => {
    expect(deriveMcpCapabilityId("github-tools", "get_repo")).toBe("mcp-github-tools.get_repo");
    expect(deriveMcpCapabilityId("docs", "Search-Docs")).toBe("mcp-docs.search-docs");
    expect(deriveMcpModule("github-tools")).toBe("mcp-github-tools");
  });

  it("rejects tool names that cannot form a valid capability id", () => {
    // The action segment must start with a letter after lowercasing.
    expect(deriveMcpCapabilityId("ok-slug", "1leading-digit")).toBeNull();
    expect(deriveMcpCapabilityId("ok-slug", " leading-space")).toBeNull();
    // Digits are fine after the leading letter.
    expect(deriveMcpCapabilityId("ok-slug", "get2fa")).toBe("mcp-ok-slug.get2fa");
  });

  it("validates the discovered tool name charset", () => {
    expect(validateDiscoveredToolName("get_workspace_info")).toBe(true);
    expect(validateDiscoveredToolName("Search-2")).toBe(true);
    expect(validateDiscoveredToolName("has space")).toBe(false);
    expect(validateDiscoveredToolName("")).toBe(false);
    expect(validateDiscoveredToolName("x".repeat(65))).toBe(false);
  });
});

describe("MCP capability namespace claims", () => {
  it("claims every id under the reserved prefix, with or without backing rows", () => {
    // The claim must survive row deletion: a deleted server's id is exactly the
    // one whose cached definition must never be served again.
    expect(claimsMcpCapabilityNamespace("mcp-docs.search_docs")).toBe(true);
    expect(claimsMcpCapabilityNamespace("mcp-docs.deleted_tool")).toBe(true);
  });

  it("never claims code-defined capability ids", () => {
    expect(claimsMcpCapabilityNamespace("users.search")).toBe(false);
    // The prefix is exact, not a substring match.
    expect(claimsMcpCapabilityNamespace("mcpdocs.search")).toBe(false);
  });
});

describe("MCP JSON schema validation", () => {
  it("validates tool input against the advertised JSON schema", () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string", minLength: 1 } },
      required: ["query"],
      additionalProperties: false,
    };
    const validator = createJsonSchemaValidator(schema);
    expect(validator.safeParse({ query: "handbook" }).success).toBe(true);
    expect(validator.safeParse({}).success).toBe(false);
    expect(validator.safeParse({ query: "handbook", extra: 1 }).success).toBe(false);
    expect(validator.safeParse("not-an-object").success).toBe(false);
  });

  it("falls back to rejecting everything when the schema cannot compile", () => {
    const validator = createJsonSchemaValidator({
      type: "object",
      properties: { broken: { $ref: "https://invalid.schema/nonexistent" } },
    });
    expect(validator.safeParse({ broken: 1 }).success).toBe(false);
    expect(validator.safeParse({}).success).toBe(false);
  });

  it("accepts JSON-shaped schema documents only", () => {
    expect(isValidJsonSchemaObject({ type: "object" })).toBe(true);
    expect(isValidJsonSchemaObject(null)).toBe(false);
    expect(isValidJsonSchemaObject([1, 2])).toBe(false);
    expect(isValidJsonSchemaObject("object")).toBe(false);
  });

  it("accepts arbitrary JSON values for tools without an output schema", () => {
    expect(jsonValueSchema.safeParse({ nested: { list: [1, "two", null, true] } }).success).toBe(true);
    expect(jsonValueSchema.safeParse("plain string").success).toBe(true);
    expect(jsonValueSchema.safeParse(undefined).success).toBe(false);
  });
});
