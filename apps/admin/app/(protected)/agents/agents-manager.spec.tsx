import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import agentsMessages from "../../../messages/en/agents.json";
import { AgentsManager } from "./agents-manager";
import type { AgentDetail, AgentListResponse, AgentManagerAccess, AgentRuntime } from "./types";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  create: vi.fn(),
  profile: vi.fn(),
  roles: vi.fn(),
  permissions: vi.fn(),
  runtime: vi.fn(),
  access: vi.fn(),
  tools: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }),
}));

vi.mock("./actions", () => ({
  createAgentAction: mocks.create,
  updateAgentProfileAction: mocks.profile,
  updateAgentRolesAction: mocks.roles,
  updateAgentPermissionsAction: mocks.permissions,
  updateAgentRuntimeAction: mocks.runtime,
  updateAgentAccessAction: mocks.access,
  replaceAgentToolsAction: mocks.tools,
}));

const initialData: AgentListResponse = {
  items: [
    {
      id: "019d2f5b-a8ab-7000-8000-000000000001",
      slug: "directory-agent",
      name: "Directory Agent",
      description: "Searches the user directory.",
      status: "active",
      isSystem: false,
      createdAt: "2026-08-27T06:00:00.000Z",
      updatedAt: "2026-08-27T06:30:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};

const fullAccess: AgentManagerAccess = {
  canCreate: true,
  canUpdateProfile: true,
  canAssignRoles: true,
  canAssignPermissions: true,
  canConfigureRuntime: true,
  canAssignAccess: true,
  canAssignTools: true,
  canReadMcpServers: true,
  canReadUsers: true,
  canReadRoles: true,
  canReadDepartments: true,
};

const detail: AgentDetail = {
  ...initialData.items[0]!,
  roles: [],
  directPermissions: [],
  effectivePermissions: ["users:read"],
};

const runtime: AgentRuntime = {
  agentId: detail.id,
  configured: true,
  modelProfileId: "019d2f5b-a8ab-7000-8000-000000000010",
  systemPrompt: "Search the employee directory safely.",
  maxOutputTokens: 1024,
  modelProfile: {
    id: "019d2f5b-a8ab-7000-8000-000000000010",
    key: "default",
    name: "Default",
    modelId: "test-model",
    status: "active",
  },
  updatedAt: "2026-08-27T06:30:00.000Z",
};

const secondDetail: AgentDetail = {
  ...detail,
  id: "019d2f5b-a8ab-7000-8000-000000000002",
  slug: "reporting-agent",
  name: "Reporting Agent",
  description: "Builds governed reports.",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function managerElement(
  access: AgentManagerAccess = fullAccess,
  options: {
    data?: AgentListResponse;
    users?: Array<{ id: string; username: string; displayName: string }>;
    userTotal?: number;
  } = {},
) {
  return (
    <AgentsManager
      initialData={options.data ?? initialData}
      roles={[]}
      permissions={[]}
      users={options.users ?? []}
      userTotal={options.userTotal ?? options.users?.length ?? 0}
      departments={[]}
      modelProfiles={runtime.modelProfile ? [runtime.modelProfile] : []}
      query={{ search: "", status: "" }}
      access={access}
    />
  );
}

function withIntl(ui: React.ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={{ agents: agentsMessages }}>
      {ui}
    </NextIntlClientProvider>
  );
}

function renderWithIntl(ui: React.ReactElement) {
  return render(withIntl(ui));
}

function renderManager(
  access: AgentManagerAccess = fullAccess,
  options: Parameters<typeof managerElement>[1] = {},
) {
  return renderWithIntl(managerElement(access, options));
}

function mockDetailRequests() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    if (path.endsWith("/capabilities")) {
      return new Response(JSON.stringify([{ id: "users.search", version: "1", module: "users", description: "Search users", risk: "low", requiredPermissions: ["users:read"] }]), { status: 200 });
    }
    if (path.endsWith("/runtime")) return new Response(JSON.stringify(runtime), { status: 200 });
    if (path.endsWith("/access")) {
      return new Response(JSON.stringify({ agentId: detail.id, users: [], roles: [], departments: [] }), { status: 200 });
    }
    if (path.endsWith(`/agents/${detail.id}/tools`)) {
      return new Response(JSON.stringify({ agentId: detail.id, toolIds: [] }), { status: 200 });
    }
    return new Response(JSON.stringify(detail), { status: 200 });
  });
}

describe("AgentsManager", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("keeps a closed Drawer out of SSR markup and hydrates without recovery", async () => {
    const element = withIntl(managerElement());
    const markup = renderToString(element);
    expect(markup).not.toContain("ant-drawer");

    const container = document.createElement("div");
    container.innerHTML = markup;
    document.body.appendChild(container);
    const recoverableErrors: unknown[] = [];
    let root!: Root;
    await act(async () => {
      root = hydrateRoot(container, element, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
      await Promise.resolve();
    });

    expect(recoverableErrors).toEqual([]);
    await act(async () => root.unmount());
    container.remove();
  });

  it("syncs only mounted tab forms without an antd disconnected-form warning", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockDetailRequests();
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getByTestId(`agent-action-${detail.id}`));
    await user.click(await screen.findByTestId("agent-tab-capabilities"));
    await user.click(screen.getByTestId("agent-tab-runtime"));
    await user.click(screen.getByTestId("agent-tab-access"));
    await screen.findByTestId("save-agent-access");

    const loggedErrors = consoleError.mock.calls.flat().map(String).join("\n");
    expect(loggedErrors).not.toContain("Instance created by `useForm` is not connected");
  });

  it("hides the tools tab without the assign-tools permission and lists only selectable MCP tools", async () => {
    const mcpToolId = "019d2f5b-a8ab-7000-8000-0000000000aa";
    const disabledToolId = "019d2f5b-a8ab-7000-8000-0000000000bb";
    const unregisteredToolId = "019d2f5b-a8ab-7000-8000-0000000000cc";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path.endsWith("/capabilities")) return new Response(JSON.stringify([]), { status: 200 });
      if (path.endsWith("/runtime")) return new Response(JSON.stringify(runtime), { status: 200 });
      if (path.endsWith("/access")) {
        return new Response(JSON.stringify({ agentId: detail.id, users: [], roles: [], departments: [] }), { status: 200 });
      }
      if (path.endsWith(`/agents/${detail.id}/tools`)) {
        return new Response(JSON.stringify({ agentId: detail.id, toolIds: [mcpToolId] }), { status: 200 });
      }
      if (path.endsWith("/mcp/servers")) {
        return new Response(
          JSON.stringify({ items: [{ id: "server-1", slug: "docs", name: "Docs", status: "active" }] }),
          { status: 200 },
        );
      }
      if (path.endsWith("/mcp/servers/server-1/tools")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: mcpToolId,
                name: "search_docs",
                description: "Search the handbook.",
                risk: "read",
                requiredPermissions: ["users:read"],
                enabled: true,
                activation: "registered",
              },
              {
                id: disabledToolId,
                name: "delete_docs",
                description: "Delete a document.",
                risk: "critical",
                requiredPermissions: ["users:read"],
                enabled: false,
                activation: "disabled",
              },
              {
                id: unregisteredToolId,
                name: "orphan_docs",
                description: "Enabled but never registered.",
                risk: "read",
                requiredPermissions: ["users:read"],
                enabled: true,
                activation: "permissions_required",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(detail), { status: 200 });
    });
    const user = userEvent.setup();
    mocks.tools.mockResolvedValue({ ok: true });
    renderManager();

    await user.click(screen.getByTestId(`agent-action-${detail.id}`));
    await user.click(await screen.findByTestId("agent-tab-tools"));
    expect(await screen.findByText("search_docs")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain("/api/mcp/servers");

    // A tool that is not enabled on its server must not be bindable.
    expect(screen.getByTestId(`tool-select-${disabledToolId}`)).toBeDisabled();
    expect(screen.getByTestId(`tool-select-${mcpToolId}`)).toBeChecked();
    // An enabled tool that never registered is still bindable, but the binding
    // is flagged: the model will never see it.
    expect(screen.getByTestId(`tool-select-${unregisteredToolId}`)).toBeEnabled();
    expect(
      screen.getByTestId("agent-tool-availability-permissions_required"),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("save-agent-tools"));
    await waitFor(() => expect(mocks.tools).toHaveBeenCalledWith(detail.id, [mcpToolId]));
  });

  it("does not render the tools tab without the assign-tools permission", async () => {
    mockDetailRequests();
    const user = userEvent.setup();
    renderManager({ ...fullAccess, canAssignTools: false });

    await user.click(screen.getByTestId(`agent-action-${detail.id}`));
    await screen.findByDisplayValue("Directory Agent");
    expect(screen.queryByTestId("agent-tab-tools")).not.toBeInTheDocument();
  });

  it("hydrates access and runtime forms when their data resolves before first tab activation", async () => {
    const existingUser = { id: "user-existing", username: "existing", displayName: "Existing User" };
    const existingRole = { id: "role-existing", key: "super-admin", name: "超级管理员" };
    const existingDepartment = {
      id: "department-existing",
      code: "OPS",
      name: "Operations",
      includeDescendants: true,
    };
    const invocationAccess = {
      agentId: detail.id,
      users: [existingUser],
      roles: [existingRole],
      departments: [existingDepartment],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path.endsWith("/capabilities")) return new Response(JSON.stringify([]), { status: 200 });
      if (path.endsWith("/runtime")) return new Response(JSON.stringify(runtime), { status: 200 });
      if (path.endsWith("/access")) return new Response(JSON.stringify(invocationAccess), { status: 200 });
      return new Response(JSON.stringify(detail), { status: 200 });
    });
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getByTestId(`agent-action-${detail.id}`));
    await screen.findByDisplayValue("Directory Agent");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(`/api/agents/${detail.id}/access`);

    await user.click(screen.getByTestId("agent-tab-access"));
    expect(await screen.findByText("Existing User / @existing")).toBeInTheDocument();
    expect(screen.getByText("超级管理员 / super-admin")).toBeInTheDocument();
    expect(screen.getByText("Operations / OPS")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeChecked();

    await user.click(screen.getByTestId("agent-tab-runtime"));
    expect(await screen.findByText("Default / test-model")).toBeInTheDocument();
    expect(screen.getByTestId("agent-system-prompt")).toHaveValue(runtime.systemPrompt);
    expect(screen.getByRole("spinbutton", { name: "Maximum output tokens" })).toHaveValue("1024");
  });

  it("renders governed agents without mutation controls for a read-only subject", () => {
    renderManager({
      canCreate: false,
      canUpdateProfile: false,
      canAssignRoles: false,
      canAssignPermissions: false,
      canConfigureRuntime: false,
      canAssignAccess: false,
      canReadUsers: false,
      canReadRoles: false,
      canReadDepartments: false,
    });

    expect(screen.getByText("Directory Agent")).toBeInTheDocument();
    expect(screen.getByText("directory-agent")).toBeInTheDocument();
    expect(screen.queryByTestId("create-agent")).not.toBeInTheDocument();
  });

  it("loads only readable governance sections for a read-only subject", async () => {
    const fetchMock = mockDetailRequests();
    const user = userEvent.setup();
    renderManager({
      canCreate: false,
      canUpdateProfile: false,
      canAssignRoles: false,
      canAssignPermissions: false,
      canConfigureRuntime: false,
      canAssignAccess: false,
      canReadUsers: false,
      canReadRoles: false,
      canReadDepartments: false,
    });

    await user.click(screen.getByTestId(`agent-action-${detail.id}`));

    expect(await screen.findByTestId("agent-tab-profile")).toBeInTheDocument();
    expect(screen.getByTestId("agent-tab-capabilities")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-tab-runtime")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-tab-access")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      `/api/agents/${detail.id}`,
      `/api/agents/${detail.id}/capabilities`,
    ]);
  });

  it("creates only the Agent profile through its server action", async () => {
    mocks.create.mockResolvedValue({ ok: true, data: detail });
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getByTestId("create-agent"));
    await user.type(screen.getByTestId("agent-slug"), "reporting-agent");
    await user.type(screen.getByTestId("agent-name"), "Reporting Agent");
    await user.click(screen.getByTestId("submit-agent"));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create).toHaveBeenCalledWith({
      slug: "reporting-agent",
      name: "Reporting Agent",
      description: "",
    });
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("exposes four independent governance sections", async () => {
    mockDetailRequests();
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getByTestId(`agent-action-${detail.id}`));

    expect(await screen.findByTestId("agent-tab-profile")).toBeInTheDocument();
    expect(screen.getByTestId("agent-tab-capabilities")).toBeInTheDocument();
    expect(screen.getByTestId("agent-tab-runtime")).toBeInTheDocument();
    expect(screen.getByTestId("agent-tab-access")).toBeInTheDocument();
    expect(screen.getByTestId("save-agent-profile")).toBeInTheDocument();

    await user.click(screen.getByTestId("agent-tab-capabilities"));
    expect(await screen.findByTestId("save-agent-roles")).toBeInTheDocument();
    expect(screen.getByTestId("save-agent-permissions")).toBeInTheDocument();

    await user.click(screen.getByTestId("agent-tab-runtime"));
    expect(await screen.findByTestId("save-agent-runtime")).toBeInTheDocument();

    await user.click(screen.getByTestId("agent-tab-access"));
    expect(await screen.findByTestId("save-agent-access")).toBeInTheDocument();
  });

  it("reloads effective permissions and capabilities after each authorization save", async () => {
    mocks.roles.mockResolvedValue({ ok: true });
    mocks.permissions.mockResolvedValue({ ok: true });
    let detailReads = 0;
    let capabilityReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path.endsWith("/capabilities")) {
        capabilityReads += 1;
        const capabilities = capabilityReads === 1
          ? []
          : [{
              id: "users.search",
              version: "1",
              module: "users",
              description: "Search users",
              risk: "low",
              requiredPermissions: ["users:read"],
            }];
        return new Response(JSON.stringify(capabilities), { status: 200 });
      }
      if (path.endsWith("/runtime")) return new Response(JSON.stringify(runtime), { status: 200 });
      if (path.endsWith("/access")) {
        return new Response(JSON.stringify({ agentId: detail.id, users: [], roles: [], departments: [] }), { status: 200 });
      }
      if (path.endsWith(`/agents/${detail.id}/tools`)) {
        return new Response(JSON.stringify({ agentId: detail.id, toolIds: [] }), { status: 200 });
      }
      detailReads += 1;
      const effectivePermissions = detailReads === 1
        ? []
        : detailReads === 2
          ? ["users:read"]
          : ["users:read", "agents:invoke"];
      return new Response(JSON.stringify({ ...detail, effectivePermissions }), { status: 200 });
    });
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getByTestId(`agent-action-${detail.id}`));
    await user.click(await screen.findByTestId("agent-tab-capabilities"));
    expect(await screen.findByText("0 effective permissions")).toBeInTheDocument();

    await user.click(screen.getByTestId("save-agent-roles"));
    expect(await screen.findByText("users.search@1")).toBeInTheDocument();
    expect(screen.getByText("1 effective permissions")).toBeInTheDocument();

    await user.click(screen.getByTestId("save-agent-permissions"));
    expect(await screen.findByText("2 effective permissions")).toBeInTheDocument();
    expect(mocks.roles).toHaveBeenCalledTimes(1);
    expect(mocks.permissions).toHaveBeenCalledTimes(1);
    expect(detailReads).toBe(3);
    expect(capabilityReads).toBe(3);
  });

  it("invalidates stale detail requests when switching Agents", async () => {
    const pendingDetail = deferred<Response>();
    const pendingCapabilities = deferred<Response>();
    const firstSignals: AbortSignal[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const path = String(input);
      if (path.includes(detail.id)) {
        firstSignals.push(init?.signal as AbortSignal);
        return path.endsWith("/capabilities") ? pendingCapabilities.promise : pendingDetail.promise;
      }
      if (path.endsWith("/capabilities")) {
        return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(secondDetail), { status: 200 }));
    });
    const user = userEvent.setup();
    const readOnlyAccess: AgentManagerAccess = {
      canCreate: false,
      canUpdateProfile: false,
      canAssignRoles: false,
      canAssignPermissions: false,
      canConfigureRuntime: false,
      canAssignAccess: false,
      canAssignTools: false,
      canReadMcpServers: false,
      canReadUsers: false,
      canReadRoles: false,
      canReadDepartments: false,
    };
    renderManager(readOnlyAccess, {
      data: {
        ...initialData,
        items: [...initialData.items, secondDetail],
        total: 2,
      },
    });

    await user.click(screen.getByTestId(`agent-action-${detail.id}`));
    await waitFor(() => expect(firstSignals).toHaveLength(2));
    await user.click(screen.getByTestId(`agent-action-${secondDetail.id}`));

    expect(await screen.findByDisplayValue("Reporting Agent")).toBeInTheDocument();
    expect(firstSignals.every((signal) => signal.aborted)).toBe(true);

    await act(async () => {
      pendingDetail.resolve(new Response(JSON.stringify(detail), { status: 200 }));
      pendingCapabilities.resolve(new Response(JSON.stringify([]), { status: 200 }));
      await Promise.all([pendingDetail.promise, pendingCapabilities.promise]);
    });
    expect(screen.getByDisplayValue("Reporting Agent")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Searches the user directory.")).not.toBeInTheDocument();
  });

  it("aborts detail requests when the Drawer closes", async () => {
    const pending = deferred<Response>();
    const signals: AbortSignal[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      signals.push(init?.signal as AbortSignal);
      return pending.promise;
    });
    const user = userEvent.setup();
    renderManager({
      canCreate: false,
      canUpdateProfile: false,
      canAssignRoles: false,
      canAssignPermissions: false,
      canConfigureRuntime: false,
      canAssignAccess: false,
      canReadUsers: false,
      canReadRoles: false,
      canReadDepartments: false,
    });

    await user.click(screen.getByTestId(`agent-action-${detail.id}`));
    await waitFor(() => expect(signals).toHaveLength(2));
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it.each([
    [403, /permissions changed/i],
    [404, /no longer exists/i],
  ])("keeps HTTP %s distinct while loading privileged sections", async (status, expectedMessage) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path.endsWith("/runtime")) return new Response(null, { status });
      if (path.endsWith("/capabilities")) return new Response(JSON.stringify([]), { status: 200 });
      if (path.endsWith("/access")) {
        return new Response(JSON.stringify({ agentId: detail.id, users: [], roles: [], departments: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(detail), { status: 200 });
    });
    const user = userEvent.setup();
    renderManager();

    await user.click(screen.getByTestId(`agent-action-${detail.id}`));
    expect(await screen.findByText(expectedMessage)).toBeInTheDocument();
  });

  it("preserves named-user grants when directory-read permission is absent", async () => {
    const existingUser = { id: "user-existing", username: "existing", displayName: "Existing User" };
    const invocationAccess = { agentId: detail.id, users: [existingUser], roles: [], departments: [] };
    mocks.access.mockResolvedValue({ ok: true, data: invocationAccess });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path.endsWith("/capabilities")) return new Response(JSON.stringify([]), { status: 200 });
      if (path.endsWith("/runtime")) return new Response(JSON.stringify(runtime), { status: 200 });
      if (path.endsWith("/access")) return new Response(JSON.stringify(invocationAccess), { status: 200 });
      return new Response(JSON.stringify(detail), { status: 200 });
    });
    const user = userEvent.setup();
    renderManager({ ...fullAccess, canReadUsers: false });

    await user.click(screen.getByTestId(`agent-action-${detail.id}`));
    await user.click(await screen.findByTestId("agent-tab-access"));

    expect(screen.getByText(/User directory permission is required/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "User grant candidates" })).toBeDisabled();
    await user.click(screen.getByTestId("save-agent-access"));
    await waitFor(() => expect(mocks.access).toHaveBeenCalledTimes(1));
    expect(mocks.access).toHaveBeenCalledWith(detail.id, {
      userIds: [existingUser.id],
      roleIds: [],
      departments: [],
    });
  });

  it("preserves role and department grants when their directory permissions are absent", async () => {
    const existingRole = { id: "role-existing", key: "operator", name: "Operator" };
    const existingDepartment = {
      id: "department-existing",
      code: "OPS",
      name: "Operations",
      includeDescendants: true,
    };
    const invocationAccess = {
      agentId: detail.id,
      users: [],
      roles: [existingRole],
      departments: [existingDepartment],
    };
    mocks.access.mockResolvedValue({ ok: true, data: invocationAccess });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path.endsWith("/capabilities")) return new Response(JSON.stringify([]), { status: 200 });
      if (path.endsWith("/runtime")) return new Response(JSON.stringify(runtime), { status: 200 });
      if (path.endsWith("/access")) return new Response(JSON.stringify(invocationAccess), { status: 200 });
      return new Response(JSON.stringify(detail), { status: 200 });
    });
    const user = userEvent.setup();
    renderManager({ ...fullAccess, canReadRoles: false, canReadDepartments: false });

    await user.click(screen.getByTestId(`agent-action-${detail.id}`));
    await user.click(await screen.findByTestId("agent-tab-access"));

    expect(screen.getByText(/Role directory permission is required/i)).toBeInTheDocument();
    expect(screen.getByText(/Department directory permission is required/i)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Role grant candidates" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Department grant" })).toBeDisabled();
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add Department" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove department grant" })).not.toBeInTheDocument();

    await user.click(screen.getByTestId("save-agent-access"));
    await waitFor(() => expect(mocks.access).toHaveBeenCalledTimes(1));
    expect(mocks.access).toHaveBeenCalledWith(detail.id, {
      userIds: [],
      roleIds: [existingRole.id],
      departments: [{ departmentId: existingDepartment.id, includeDescendants: true }],
    });
  });

  it("searches and paginates named-user candidates remotely without dropping current grants", async () => {
    const seedUser = { id: "user-seed", username: "seed", displayName: "Seed User" };
    const existingUser = { id: "user-existing", username: "existing", displayName: "Existing User" };
    const pageTwoUser = { id: "user-page-2", username: "page-two", displayName: "Page Two User" };
    const searchedUser = { id: "user-alex", username: "alex", displayName: "Alex Chen" };
    const invocationAccess = { agentId: detail.id, users: [existingUser], roles: [], departments: [] };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path.startsWith("/api/users?")) {
        const url = new URL(path, "http://localhost");
        const searching = url.searchParams.get("search") === "alex";
        return new Response(JSON.stringify({
          items: searching ? [searchedUser] : [pageTwoUser],
          total: searching ? 1 : 40,
          page: Number(url.searchParams.get("page")),
          pageSize: 20,
        }), { status: 200 });
      }
      if (path.endsWith("/capabilities")) return new Response(JSON.stringify([]), { status: 200 });
      if (path.endsWith("/runtime")) return new Response(JSON.stringify(runtime), { status: 200 });
      if (path.endsWith("/access")) return new Response(JSON.stringify(invocationAccess), { status: 200 });
      return new Response(JSON.stringify(detail), { status: 200 });
    });
    const user = userEvent.setup();
    renderManager(fullAccess, { users: [seedUser], userTotal: 40 });

    await user.click(screen.getByTestId(`agent-action-${detail.id}`));
    await user.click(await screen.findByTestId("agent-tab-access"));
    const userSelect = screen.getByRole("combobox", { name: "User grant candidates" });
    await user.click(userSelect);
    const scrollHolder = document.querySelector(".ant-select-dropdown-list-holder") as HTMLDivElement;
    Object.defineProperties(scrollHolder, {
      scrollTop: { configurable: true, value: 0, writable: true },
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 100 },
    });
    fireEvent.scroll(scrollHolder);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/users?page=2&pageSize=20",
      expect.objectContaining({ cache: "no-store", credentials: "include" }),
    ));

    await user.type(userSelect, "alex");
    expect(await screen.findByText("Alex Chen / @alex")).toBeInTheDocument();
    expect(screen.getAllByText("Existing User / @existing").length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/users?page=1&pageSize=20&search=alex",
      expect.objectContaining({ cache: "no-store", credentials: "include" }),
    );
  });

  it("moves list filters into the URL", async () => {
    const user = userEvent.setup();
    renderManager();

    await user.type(screen.getByTestId("agent-search"), "directory");
    await user.click(screen.getByTestId("apply-agent-filters"));
    expect(mocks.push).toHaveBeenCalledWith("/agents?search=directory");
  });
});
