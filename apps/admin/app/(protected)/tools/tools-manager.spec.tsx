import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import toolsMessages from "../../../messages/en/tools.json";
import { ToolsManager } from "./tools-manager";
import type { McpServer, McpServerListResponse } from "./types";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  sync: vi.fn(),
  updateTool: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh }),
}));

vi.mock("./actions", () => ({
  createServerAction: mocks.create,
  updateServerAction: mocks.update,
  deleteServerAction: mocks.remove,
  syncServerAction: mocks.sync,
  updateToolAction: mocks.updateTool,
}));

const authedServer: McpServer = {
  id: "019d2f5b-a8ab-7000-8000-000000000101",
  slug: "github-tools",
  name: "GitHub Tools",
  description: "Issues and pull requests.",
  endpointUrl: "https://mcp.example.com/mcp",
  hasAuth: true,
  authEnvVar: "MCP_GITHUB_TOKEN",
  status: "active",
  toolCount: 0,
  lastSyncedAt: null,
  lastSyncErrorCode: null,
};

const initialData: McpServerListResponse = { items: [authedServer] };

function renderManager() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ tools: toolsMessages }}>
      <ToolsManager initialData={initialData} access={{ canManage: true }} />
    </NextIntlClientProvider>,
  );
}

async function openEditDrawer() {
  const user = userEvent.setup();
  renderManager();
  await user.click(screen.getByText("GitHub Tools"));
  await screen.findByTestId("server-endpoint");
  return user;
}

describe("ToolsManager credential handling", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("never prefills the stored credential pair", async () => {
    await openEditDrawer();

    expect(screen.getByPlaceholderText("Authorization")).toHaveValue("");
    expect(screen.getByPlaceholderText("MCP_GITHUB_TOKEN")).toHaveValue("");
    // The env var *name* is surfaced so an operator knows what backs this server.
    expect(screen.getByText(/MCP_GITHUB_TOKEN/)).toBeInTheDocument();
  });

  it("keeps stored credentials when an unrelated field is edited", async () => {
    mocks.update.mockResolvedValue({ ok: true, data: authedServer });
    const user = await openEditDrawer();

    const nameInput = screen.getByTestId("server-name");
    await user.clear(nameInput);
    await user.type(nameInput, "GitHub Tools Renamed");
    await user.click(screen.getByTestId("submit-server"));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    const [, payload] = mocks.update.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({ name: "GitHub Tools Renamed" });
    // Omitting the pair is what preserves it server-side.
    expect(payload).not.toHaveProperty("authHeaderName");
    expect(payload).not.toHaveProperty("authEnvVar");
    expect(payload).not.toHaveProperty("clearAuth");
  });

  it("replaces credentials only when both fields are filled in", async () => {
    mocks.update.mockResolvedValue({ ok: true, data: authedServer });
    const user = await openEditDrawer();

    await user.type(screen.getByPlaceholderText("Authorization"), "X-Api-Key");
    await user.type(screen.getByPlaceholderText("MCP_GITHUB_TOKEN"), "MCP_ROTATED_TOKEN");
    await user.click(screen.getByTestId("submit-server"));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    const [, payload] = mocks.update.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({
      authHeaderName: "X-Api-Key",
      authEnvVar: "MCP_ROTATED_TOKEN",
    });
    expect(payload).not.toHaveProperty("clearAuth");
  });

  it("refuses a half-configured credential pair instead of saving", async () => {
    // Both interactions matter: a change event alone must not persist, and the
    // explicit submit must not either. The call-count read follows the render
    // of the guard's alert, the one synchronous step in submit().
    const user = await openEditDrawer();

    await user.type(screen.getByPlaceholderText("Authorization"), "X-Api-Key");
    expect(mocks.update).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("submit-server"));
    // The message surfaces in both the page and the drawer alerts.
    expect((await screen.findAllByText(toolsMessages.errors.authPairRequired)).length).toBeGreaterThan(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("clears credentials only through the explicit affordance", async () => {
    mocks.update.mockResolvedValue({ ok: true, data: { ...authedServer, hasAuth: false } });
    const user = await openEditDrawer();

    await user.click(screen.getByTestId("toggle-clear-auth"));
    expect(await screen.findByText(toolsMessages.form.authClearWarning)).toBeInTheDocument();
    await user.click(screen.getByTestId("submit-server"));

    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    const [, payload] = mocks.update.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload).toMatchObject({ clearAuth: true });
    expect(payload).not.toHaveProperty("authHeaderName");
    expect(payload).not.toHaveProperty("authEnvVar");
  });
});
