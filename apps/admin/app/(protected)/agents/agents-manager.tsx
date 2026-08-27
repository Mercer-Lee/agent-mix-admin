"use client";

import {
  ApiOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  type TableProps,
} from "antd";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { createAgentAction, updateAgentAction } from "./actions";
import type {
  AgentAccess,
  AgentDetail,
  AgentListResponse,
  AgentMutationInput,
  AgentSummary,
  CapabilityDescriptor,
  PermissionOption,
  RoleOption,
} from "./types";

interface AgentsManagerProps {
  initialData: AgentListResponse;
  roles: RoleOption[];
  permissions: PermissionOption[];
  query: { search: string; status: string };
  access: AgentAccess;
}

interface AgentFormValues extends AgentMutationInput {
  slug: string;
  status: "active" | "disabled";
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function AgentsManager({ initialData, roles, permissions, query, access }: AgentsManagerProps) {
  const router = useRouter();
  const [form] = Form.useForm<AgentFormValues>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [mode, setMode] = useState<"create" | "detail">("create");
  const [selected, setSelected] = useState<AgentDetail | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityDescriptor[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(query.search);
  const [status, setStatus] = useState(query.status);

  const roleOptions = useMemo(
    () => roles.map((role) => ({ label: `${role.name} / ${role.key}`, value: role.id })),
    [roles],
  );
  const permissionOptions = useMemo(
    () =>
      permissions.map((permission) => ({
        label: `${permission.key} — ${permission.description}`,
        value: permission.id,
      })),
    [permissions],
  );

  function navigate(nextPage = 1) {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (status) params.set("status", status);
    if (nextPage > 1) params.set("page", String(nextPage));
    router.push(params.size ? `/agents?${params}` : "/agents");
  }

  function openCreate() {
    setMode("create");
    setSelected(null);
    setCapabilities([]);
    setError(null);
    form.setFieldsValue({
      slug: "",
      name: "",
      description: "",
      status: "active",
      roleIds: [],
      permissionIds: [],
    });
    setDrawerOpen(true);
  }

  async function openDetail(agent: AgentSummary) {
    setMode("detail");
    setSelected(null);
    setCapabilities([]);
    setError(null);
    form.resetFields();
    setDrawerOpen(true);
    setLoadingDetail(true);
    try {
      const [detailResponse, capabilityResponse] = await Promise.all([
        fetch(`/api/agents/${agent.id}`, { credentials: "include", cache: "no-store" }),
        fetch(`/api/agents/${agent.id}/capabilities`, { credentials: "include", cache: "no-store" }),
      ]);
      if (!detailResponse.ok || !capabilityResponse.ok) throw new Error("Agent detail request failed");
      const detail = (await detailResponse.json()) as AgentDetail;
      const availableCapabilities = (await capabilityResponse.json()) as CapabilityDescriptor[];
      setSelected(detail);
      setCapabilities(availableCapabilities);
      form.setFieldsValue({
        slug: detail.slug,
        name: detail.name,
        description: detail.description,
        status: detail.status,
        roleIds: detail.roles.map((role) => role.id),
        permissionIds: detail.directPermissions.map((permission) => permission.id),
      });
    } catch {
      setError("Unable to load agent details. Refresh the page and try again.");
    } finally {
      setLoadingDetail(false);
    }
  }

  async function submit(values: AgentFormValues) {
    setSaving(true);
    setError(null);
    const payload: AgentMutationInput = {
      slug: values.slug,
      name: values.name,
      description: values.description ?? "",
      status: values.status ?? "active",
      roleIds: values.roleIds ?? [],
      permissionIds: values.permissionIds ?? [],
    };
    const result =
      mode === "create"
        ? await createAgentAction(payload)
        : await updateAgentAction(selected!.id, payload);
    setSaving(false);
    if (!result.ok) {
      setError(result.error ?? "The operation failed. Try again later.");
      return;
    }
    setDrawerOpen(false);
    router.refresh();
  }

  const columns: TableProps<AgentSummary>["columns"] = [
    {
      title: "Agent",
      key: "agent",
      render: (_, agent) => (
        <div className="min-w-48">
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm font-semibold text-zinc-100 hover:text-[#caff24]"
            onClick={() => void openDetail(agent)}
          >
            {agent.name}
          </button>
          <div className="mt-1 font-mono text-xs text-zinc-600">{agent.slug}</div>
        </div>
      ),
    },
    {
      title: "Status",
      dataIndex: "status",
      width: 110,
      render: (value: AgentSummary["status"]) =>
        value === "active" ? <Tag color="lime">Active</Tag> : <Tag>Disabled</Tag>,
    },
    {
      title: "Description",
      dataIndex: "description",
      ellipsis: true,
      render: (value: string) => <span className="text-zinc-400">{value || "—"}</span>,
    },
    {
      title: "Updated",
      dataIndex: "updatedAt",
      width: 170,
      render: (value: string) => (
        <span className="font-mono text-xs text-zinc-500">{dateFormatter.format(new Date(value))}</span>
      ),
    },
    {
      title: "",
      key: "action",
      width: 90,
      render: (_, agent) => (
        <Button
          data-testid={`agent-action-${agent.id}`}
          type="text"
          icon={access.canUpdateAll ? <EditOutlined /> : <ApiOutlined />}
          onClick={() => void openDetail(agent)}
        >
          {access.canUpdateAll ? "Manage" : "View"}
        </Button>
      ),
    },
  ];

  const readOnly = mode === "detail" && !access.canUpdateAll;

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <section className="mb-8 flex flex-col justify-between gap-5 md:flex-row md:items-end">
        <div>
          <p className="m-0 font-mono text-xs tracking-[0.26em] text-[#b8f500] uppercase">
            Governed resources / Agents
          </p>
          <h1 className="mb-0 mt-3 text-4xl font-semibold tracking-[-0.045em]">Agent Management</h1>
          <p className="mb-0 mt-3 max-w-2xl text-sm leading-6 text-zinc-500">
            Each agent is an independent subject. Inherited roles and direct permissions determine its
            capabilities, always intersected with the current user permissions.
          </p>
        </div>
        {access.canCreate ? (
          <Button
            data-testid="create-agent"
            type="primary"
            size="large"
            icon={<PlusOutlined />}
            onClick={openCreate}
          >
            Create Agent
          </Button>
        ) : null}
      </section>

      <section className="border border-white/10 bg-white/[0.025]">
        <div className="flex flex-col gap-3 border-b border-white/10 p-4 md:flex-row">
          <Input
            data-testid="agent-search"
            allowClear
            aria-label="Search agents"
            className="md:max-w-sm"
            prefix={<SearchOutlined />}
            placeholder="Search by name or slug"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onPressEnter={() => navigate()}
          />
          <Select
            aria-label="Filter by status"
            className="w-full md:w-40"
            value={status}
            options={[
              { label: "All statuses", value: "" },
              { label: "Active", value: "active" },
              { label: "Disabled", value: "disabled" },
            ]}
            onChange={setStatus}
          />
          <Button data-testid="apply-agent-filters" icon={<ReloadOutlined />} onClick={() => navigate()}>
            Apply Filters
          </Button>
        </div>
        <Table<AgentSummary>
          rowKey="id"
          columns={columns}
          dataSource={initialData.items}
          locale={{ emptyText: <Empty description="No agents match the current filters" /> }}
          pagination={{
            current: initialData.page,
            pageSize: initialData.pageSize,
            total: initialData.total,
            showSizeChanger: false,
            showTotal: (total) => `${total} agents`,
            onChange: (page) => navigate(page),
          }}
        />
      </section>

      <Drawer
        destroyOnHidden
        size={680}
        open={drawerOpen}
        title={mode === "create" ? "Create Governed Agent" : selected?.name ?? "Loading Agent"}
        extra={
          mode === "detail" && selected ? (
            <Tag color={selected.status === "active" ? "lime" : "default"}>
              {selected.status === "active" ? "ACTIVE" : "DISABLED"}
            </Tag>
          ) : null
        }
        onClose={() => setDrawerOpen(false)}
      >
        {error ? <Alert className="mb-5" type="error" showIcon title={error} /> : null}
        {loadingDetail ? (
          <div className="py-20 text-center text-zinc-500">Resolving the agent authorization boundary…</div>
        ) : (
          <>
            {mode === "detail" && selected ? (
              <Descriptions className="mb-6" size="small" column={2} bordered>
                <Descriptions.Item label="Subject ID" span={2}>
                  <Typography.Text copyable className="font-mono text-xs">
                    {selected.id}
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label="Effective permissions">
                  {selected.effectivePermissions.length}
                </Descriptions.Item>
                <Descriptions.Item label="Available capabilities">{capabilities.length}</Descriptions.Item>
              </Descriptions>
            ) : null}

            <Form<AgentFormValues>
              form={form}
              layout="vertical"
              requiredMark={false}
              disabled={readOnly}
              onFinish={(values) => void submit(values)}
            >
              <div className="grid gap-x-4 md:grid-cols-2">
                <Form.Item
                  name="slug"
                  label="Unique slug"
                  rules={[
                    { required: true, message: "Enter an agent slug" },
                    {
                      pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
                      message: "Use lowercase letters, numbers, and hyphens only",
                    },
                    { min: 3, max: 100, message: "Slug must contain between 3 and 100 characters" },
                  ]}
                >
                  <Input
                    data-testid="agent-slug"
                    disabled={mode === "detail" || readOnly}
                    placeholder="user-query-agent"
                  />
                </Form.Item>
                <Form.Item
                  name="name"
                  label="Display name"
                  rules={[{ required: true, message: "Enter a display name" }, { max: 120 }]}
                >
                  <Input data-testid="agent-name" placeholder="Directory Agent" />
                </Form.Item>
              </div>
              <Form.Item
                name="description"
                label="Responsibilities"
                rules={[{ max: 2000 }]}
              >
                <Input.TextArea
                  rows={3}
                  placeholder="Describe this agent's responsibility boundary. Never include secrets."
                />
              </Form.Item>
              {mode === "detail" ? (
                <Form.Item
                  name="status"
                  label="Runtime status"
                  rules={[{ required: true }]}
                >
                  <Select
                    options={[
                      { label: "Active", value: "active" },
                      { label: "Disabled", value: "disabled" },
                    ]}
                  />
                </Form.Item>
              ) : null}

              <div className="mb-4 mt-7 flex items-center gap-2 border-t border-white/10 pt-6">
                <SafetyCertificateOutlined className="text-[#b8f500]" />
                <span className="font-medium">Authorization Boundary</span>
                <Tooltip title="Effective capabilities are also intersected with the permissions of the current user.">
                  <span className="cursor-help font-mono text-xs text-zinc-600">ACTOR ∩ AGENT</span>
                </Tooltip>
              </div>
              <Form.Item name="roleIds" label="Inherited roles">
                <Select
                  mode="multiple"
                  disabled={readOnly || !access.canAssignRoles}
                  options={roleOptions}
                  placeholder={access.canAssignRoles ? "Select roles to inherit" : "Your account cannot assign roles"}
                />
              </Form.Item>
              <Form.Item name="permissionIds" label="Direct permissions">
                <Select
                  mode="multiple"
                  disabled={readOnly || !access.canAssignPermissions}
                  options={permissionOptions}
                  optionFilterProp="label"
                  placeholder={
                    access.canAssignPermissions
                      ? "Select least-privilege direct permissions"
                      : "Your account cannot assign direct permissions"
                  }
                />
              </Form.Item>

              {mode === "detail" && selected ? (
                <section className="mt-7 border border-white/10 bg-black/20 p-4">
                  <div className="mb-3 flex items-center gap-2">
                    <RobotOutlined className="text-[#b8f500]" />
                    <span className="font-medium">Available Capabilities</span>
                  </div>
                  {capabilities.length ? (
                    <Space size={[8, 8]} wrap>
                      {capabilities.map((capability) => (
                        <Tooltip
                          key={capability.id}
                          title={`${capability.description} · ${capability.requiredPermissions.join(", ")}`}
                        >
                          <Tag color="lime">
                            {capability.id}@{capability.version}
                          </Tag>
                        </Tooltip>
                      ))}
                    </Space>
                  ) : (
                    <p className="m-0 text-sm text-zinc-600">
                      No capabilities are available for the current status and authorization boundary.
                    </p>
                  )}
                </section>
              ) : null}

              {!readOnly ? (
                <div className="mt-7 flex justify-end gap-3">
                  <Button onClick={() => setDrawerOpen(false)}>Cancel</Button>
                  <Button data-testid="submit-agent" type="primary" htmlType="submit" loading={saving}>
                    {mode === "create" ? "Create Agent" : "Save Governance Settings"}
                  </Button>
                </div>
              ) : null}
            </Form>
          </>
        )}
      </Drawer>
    </main>
  );
}
