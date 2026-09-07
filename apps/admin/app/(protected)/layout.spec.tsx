import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProtectedLayout from "./layout";

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  redirect: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../_lib/auth", () => ({ getAuthContext: mocks.getAuthContext }));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));

describe("ProtectedLayout", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders Overview once in each responsive navigation", async () => {
    mocks.getAuthContext.mockResolvedValue({
      user: {
        id: "019d2f5b-a8ab-7000-8000-000000000001",
        username: "admin",
        displayName: "Admin",
        email: null,
        department: null,
      },
      roles: [],
      permissions: ["models:read", "agents:read", "agents:invoke", "audit-logs:read"],
    });

    render(await ProtectedLayout({ children: <div>Protected content</div> }));

    expect(within(screen.getByRole("navigation", { name: "Main navigation" })).getAllByRole("link", { name: "Overview" })).toHaveLength(1);
    expect(within(screen.getByRole("navigation", { name: "Mobile navigation" })).getAllByRole("link", { name: "Overview" })).toHaveLength(1);
  });
});
