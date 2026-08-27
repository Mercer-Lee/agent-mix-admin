import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentsManager } from "./agents-manager";
import type { AgentAccess, AgentListResponse } from "./types";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock("./actions", () => ({
  createAgentAction: mocks.create,
  updateAgentAction: mocks.update,
}));

const initialData: AgentListResponse = {
  items: [
    {
      id: "019d2f5b-a8ab-7000-8000-000000000001",
      slug: "directory-agent",
      name: "Directory Agent",
      description: "Searches the user directory.",
      status: "active",
      createdAt: "2026-08-27T06:00:00.000Z",
      updatedAt: "2026-08-27T06:30:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};

const fullAccess: AgentAccess = {
  canCreate: true,
  canAssignRoles: true,
  canAssignPermissions: true,
  canUpdateAll: true,
};

describe("AgentsManager", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders governed agents without mutation controls for a read-only subject", () => {
    render(
      <AgentsManager
        initialData={initialData}
        roles={[]}
        permissions={[]}
        query={{ search: "", status: "" }}
        access={{ ...fullAccess, canCreate: false, canUpdateAll: false }}
      />,
    );

    expect(screen.getByText("Directory Agent")).toBeInTheDocument();
    expect(screen.getByText("directory-agent")).toBeInTheDocument();
    expect(screen.getByTestId(`agent-action-${initialData.items[0]!.id}`)).toBeInTheDocument();
    expect(screen.queryByTestId("create-agent")).not.toBeInTheDocument();
  });

  it("creates a blank agent through the server action", async () => {
    mocks.create.mockResolvedValue({ ok: true, agent: { id: "new-agent" } });
    const user = userEvent.setup();
    render(
      <AgentsManager
        initialData={initialData}
        roles={[]}
        permissions={[]}
        query={{ search: "", status: "" }}
        access={fullAccess}
      />,
    );

    await user.click(screen.getByTestId("create-agent"));
    await user.type(screen.getByTestId("agent-slug"), "reporting-agent");
    await user.type(screen.getByTestId("agent-name"), "Reporting Agent");
    await user.click(screen.getByTestId("submit-agent"));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create).toHaveBeenCalledWith({
      slug: "reporting-agent",
      name: "Reporting Agent",
      description: "",
      status: "active",
      roleIds: [],
      permissionIds: [],
    });
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("moves list filters into the URL", async () => {
    const user = userEvent.setup();
    render(
      <AgentsManager
        initialData={initialData}
        roles={[]}
        permissions={[]}
        query={{ search: "", status: "" }}
        access={fullAccess}
      />,
    );

    await user.type(screen.getByTestId("agent-search"), "directory");
    await user.click(screen.getByTestId("apply-agent-filters"));
    expect(mocks.push).toHaveBeenCalledWith("/agents?search=directory");
  });
});
