import { cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import commonMessages from "../../messages/en/common.json";
import ProtectedLayout from "./layout";

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  redirect: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  pathname: vi.fn(() => "/"),
}));

vi.mock("../_lib/auth", () => ({ getAuthContext: mocks.getAuthContext }));
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  usePathname: mocks.pathname,
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}));

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ app: commonMessages.app }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

function setViewport(matchLg: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matchLg && query.includes("min-width: 992"),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

describe("ProtectedLayout", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setViewport(false);
  });

  it("renders permitted items in the sidebar navigation", async () => {
    setViewport(true);
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

    renderWithIntl(await ProtectedLayout({ children: <div>Protected content</div> }));

    const navigation = within(screen.getByRole("navigation", { name: "Main navigation" }));
    expect(navigation.getAllByRole("link", { name: "Overview" })).toHaveLength(1);
    expect(navigation.getAllByRole("link", { name: "Models" })).toHaveLength(1);
    expect(navigation.getAllByRole("link", { name: "Agents" })).toHaveLength(1);
    expect(navigation.getAllByRole("link", { name: "Workbench" })).toHaveLength(1);
    expect(navigation.getAllByRole("link", { name: "Audit" })).toHaveLength(1);
    expect(screen.getByText("Protected content")).toBeInTheDocument();
  });

  it("hides navigation items the user lacks permission for", async () => {
    setViewport(true);
    mocks.getAuthContext.mockResolvedValue({
      user: {
        id: "019d2f5b-a8ab-7000-8000-000000000002",
        username: "operator",
        displayName: "Operator",
        email: null,
        department: null,
      },
      roles: [],
      permissions: ["agents:read"],
    });

    renderWithIntl(await ProtectedLayout({ children: <div>Protected content</div> }));

    const navigation = within(screen.getByRole("navigation", { name: "Main navigation" }));
    expect(navigation.getAllByRole("link", { name: "Overview" })).toHaveLength(1);
    expect(navigation.getAllByRole("link", { name: "Agents" })).toHaveLength(1);
    expect(navigation.queryByRole("link", { name: "Models" })).not.toBeInTheDocument();
    expect(navigation.queryByRole("link", { name: "Workbench" })).not.toBeInTheDocument();
    expect(navigation.queryByRole("link", { name: "Audit" })).not.toBeInTheDocument();
  });

  it("shows the signed-in identity and sign-out control", async () => {
    setViewport(true);
    mocks.getAuthContext.mockResolvedValue({
      user: {
        id: "019d2f5b-a8ab-7000-8000-000000000001",
        username: "admin",
        displayName: "Admin",
        email: null,
        department: null,
      },
      roles: [],
      permissions: [],
    });

    renderWithIntl(await ProtectedLayout({ children: <div>Protected content</div> }));

    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.getByText("@admin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("opens the sidebar through the trigger on mobile viewports", async () => {
    mocks.getAuthContext.mockResolvedValue({
      user: {
        id: "019d2f5b-a8ab-7000-8000-000000000001",
        username: "admin",
        displayName: "Admin",
        email: null,
        department: null,
      },
      roles: [],
      permissions: ["agents:read"],
    });

    renderWithIntl(await ProtectedLayout({ children: <div>Protected content</div> }));

    expect(screen.queryByRole("navigation", { name: "Main navigation" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
  });

  it("redirects to /login when unauthenticated", async () => {
    mocks.getAuthContext.mockResolvedValue(null);
    mocks.redirect.mockImplementationOnce(() => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(ProtectedLayout({ children: <div>Protected content</div> })).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(mocks.redirect).toHaveBeenCalledWith("/login");
  });
});
