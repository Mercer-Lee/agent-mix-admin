"use client";

import {
  ApiOutlined,
  CloudDownloadOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  SafetyOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Drawer,
  Form,
  Input,
  Popconfirm,
  Select,
  Switch,
  Table,
  Tag,
  Tooltip,
  type TableProps,
} from "antd";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  createServerAction,
  deleteServerAction,
  syncServerAction,
  updateServerAction,
  updateToolAction,
} from "./actions";
import type {
  McpServer,
  McpServerAccess,
  McpServerListResponse,
  McpServerUpdateInput,
  McpTool,
  McpToolActivation,
  McpToolListResponse,
  McpToolMutationInput,
  McpToolRisk,
} from "./types";

interface ToolsManagerProps {
  initialData: McpServerListResponse;
  access: McpServerAccess;
}

interface ServerFormValues {
  slug: string;
  name: string;
  description: string;
  endpointUrl: string;
  authHeaderName: string | null;
  authEnvVar: string | null;
  status: "active" | "disabled";
}

const RISK_TAG_COLOR: Record<McpToolRisk, string> = {
  read: "default",
  sensitive_read: "gold",
  write: "orange",
  critical: "red",
};

function serverHasAuth(server: McpServer): boolean {
  return Boolean(server.authEnvVar);
}

function readJson<T>(path: string): Promise<T> {
  return fetch(path, { credentials: "include", cache: "no-store" }).then((response) => {
    if (!response.ok) throw new Error(`${response.status}`);
    return response.json() as Promise<T>;
  });
}

export function ToolsManager({ initialData, access }: ToolsManagerProps) {
  const t = useTranslations("tools");
  const router = useRouter();
  const [form] = Form.useForm<ServerFormValues>();
  const [servers, setServers] = useState(initialData.items);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selected, setSelected] = useState<McpServer | null>(null);
  const [toolsFor, setToolsFor] = useState<McpServer | null>(null);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [clearAuth, setClearAuth] = useState(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function openCreate() {
    setSelected(null);
    setError(null);
    setClearAuth(false);
    form.setFieldsValue({
      slug: "",
      name: "",
      description: "",
      endpointUrl: "",
      authHeaderName: "",
      authEnvVar: "",
      status: "active",
    });
    setDrawerOpen(true);
  }

  function openEdit(server: McpServer) {
    setSelected(server);
    setError(null);
    setClearAuth(false);
    // Auth is write-only: the form never receives the stored header/env pair,
    // and leaving both blank keeps whatever the server already has.
    form.setFieldsValue({
      slug: server.slug,
      name: server.name,
      description: server.description,
      endpointUrl: server.endpointUrl,
      authHeaderName: "",
      authEnvVar: "",
      status: server.status,
    });
    setDrawerOpen(true);
  }

  async function submit(values: ServerFormValues) {
    setSaving(true);
    setError(null);
    const authHeaderName = values.authHeaderName?.trim() ?? "";
    const authEnvVar = values.authEnvVar?.trim() ?? "";
    if (authHeaderName && !authEnvVar) {
      setSaving(false);
      setError(t("errors.authPairRequired"));
      return;
    }
    const credentialPatch: Pick<
      McpServerUpdateInput,
      "authHeaderName" | "authEnvVar" | "clearAuth"
    > = clearAuth
      ? { clearAuth: true }
      : authHeaderName && authEnvVar
        ? { authHeaderName, authEnvVar }
        : {};
    const payload: McpServerUpdateInput = {
      name: values.name,
      description: values.description,
      endpointUrl: values.endpointUrl,
      ...credentialPatch,
      status: values.status,
    };
    const result = selected
      ? await updateServerAction(selected.id, payload)
      : await createServerAction({ ...payload, slug: values.slug });
    setSaving(false);
    if (!result.ok || !result.data) {
      setError(result.error ?? t("errors.saveFailed"));
      return;
    }
    const saved = result.data;
    setServers((current) => {
      const exists = current.some((server) => server.id === saved.id);
      return exists
        ? current.map((server) => (server.id === saved.id ? saved : server))
        : [saved, ...current];
    });
    setDrawerOpen(false);
    router.refresh();
  }

  async function runSync(server: McpServer) {
    setSyncingId(server.id);
    setNotice(null);
    setError(null);
    const result = await syncServerAction(server.id);
    setSyncingId(null);
    if (!result.ok || !result.data) {
      setError(result.error ?? t("errors.syncFailed"));
      // Refresh regardless: the server row now carries the sync error code.
      void readJson<McpServerListResponse>("/api/mcp/servers").then((response) => {
        setServers(response.items);
      });
      return;
    }
    setNotice({
      type: "success",
      message: t("notices.synced", { added: result.data.added, updated: result.data.updated, removed: result.data.removed.length }),
    });
    const refreshed = await readJson<McpServerListResponse>("/api/mcp/servers");
    setServers(refreshed.items);
    router.refresh();
  }

  async function openTools(server: McpServer) {
    setToolsFor(server);
    setToolsLoading(true);
    setNotice(null);
    try {
      const response = await readJson<McpToolListResponse>(`/api/mcp/servers/${server.id}/tools`);
      setTools(response.items);
    } catch {
      setTools([]);
    } finally {
      setToolsLoading(false);
    }
  }

  async function toggleTool(tool: McpTool, patch: McpToolMutationInput) {
    setNotice(null);
    const result = await updateToolAction(tool.id, patch);
    if (!result.ok) {
      setNotice({ type: "error", message: result.error ?? t("errors.saveFailed") });
      return;
    }
    setTools((current) =>
      current.map((item) => (item.id === tool.id ? { ...item, ...patch } : item)),
    );
    router.refresh();
  }

  async function removeServer(server: McpServer) {
    setError(null);
    const result = await deleteServerAction(server.id);
    if (!result.ok) {
      setError(result.error ?? t("errors.deleteFailed"));
      return;
    }
    setServers((current) => current.filter((item) => item.id !== server.id));
    router.refresh();
  }

  // Enabled tools that a governed run still cannot call: the model never sees
  // them, so an agent bound to one silently loses that tool.
  const unusableTools = tools.filter(
    (tool) => tool.activation !== "registered" && tool.activation !== "disabled",
  );

  const columns: TableProps<McpServer>["columns"] = [
    {
      title: t("table.server"),
      key: "server",
      render: (_, server) => (
        <div className="min-w-44">
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm font-semibold text-zinc-100 hover:text-[#caff24]"
            onClick={() => openEdit(server)}
          >
            {server.name}
          </button>
          <div className="mt-1 font-mono text-xs text-zinc-600">{server.slug}</div>
        </div>
      ),
    },
    {
      title: t("table.endpoint"),
      dataIndex: "endpointUrl",
      render: (value: string) => <span className="font-mono text-xs break-all text-zinc-400">{value}</span>,
    },
    {
      title: t("table.tools"),
      dataIndex: "toolCount",
      width: 90,
      render: (value: number, server) => (
        <button
          type="button"
          data-testid={`tools-${server.id}`}
          className="cursor-pointer border-0 bg-transparent p-0 font-mono text-xs text-[#caff24] hover:underline"
          onClick={() => void openTools(server)}
        >
          {value} {t("table.toolsUnit")}
        </button>
      ),
    },
    {
      title: t("table.lastSync"),
      key: "lastSync",
      width: 180,
      render: (_, server) => (
        <div>
          <span className="text-xs text-zinc-400">
            {server.lastSyncedAt
              ? new Date(server.lastSyncedAt).toLocaleString()
              : t("table.neverSynced")}
          </span>
          {server.lastSyncErrorCode ? (
            <div className="mt-1 font-mono text-[11px] text-red-300/70">{server.lastSyncErrorCode}</div>
          ) : null}
        </div>
      ),
    },
    {
      title: t("table.status"),
      dataIndex: "status",
      width: 100,
      render: (status: McpServer["status"]) =>
        status === "active" ? <Tag color="lime">ACTIVE</Tag> : <Tag>DISABLED</Tag>,
    },
    {
      title: "",
      key: "actions",
      width: 260,
      render: (_, server) =>
        access.canManage ? (
          <div className="flex justify-end gap-1">
            <Button
              data-testid={`sync-server-${server.id}`}
              type="text"
              icon={<CloudDownloadOutlined />}
              loading={syncingId === server.id}
              onClick={() => void runSync(server)}
            >
              {t("table.sync")}
            </Button>
            <Button type="text" icon={<EditOutlined />} onClick={() => openEdit(server)}>
              {t("table.edit")}
            </Button>
            <Popconfirm title={t("table.deleteConfirm")} onConfirm={() => void removeServer(server)}>
              <Button type="text" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button type="text" icon={<ApiOutlined />} onClick={() => openEdit(server)}>
              {t("table.view")}
            </Button>
          </div>
        ),
    },
  ];

  const toolColumns: TableProps<McpTool>["columns"] = [
    {
      title: t("toolTable.tool"),
      key: "tool",
      render: (_, tool) => (
        <div className="min-w-40">
          <span className="font-mono text-xs text-zinc-100">{tool.name}</span>
          <div className="mt-1 text-xs text-zinc-500">{tool.description || t("toolTable.noDescription")}</div>
        </div>
      ),
    },
    {
      // A dedicated key: `toolTable.risk` is a namespace of per-level labels, so
      // it can never resolve as a plain string.
      title: t("toolTable.riskLevel"),
      dataIndex: "risk",
      width: 130,
      render: (risk: McpToolRisk, tool) =>
        access.canManage ? (
          <Select<McpToolRisk>
            size="small"
            value={risk}
            style={{ width: 130 }}
            onChange={(value) => void toggleTool(tool, { risk: value })}
            options={(Object.keys(RISK_TAG_COLOR) as McpToolRisk[]).map((value) => ({
              value,
              label: t(`toolTable.risk.${value}`),
            }))}
          />
        ) : (
          <Tag color={RISK_TAG_COLOR[risk]}>{t(`toolTable.risk.${risk}`)}</Tag>
        ),
    },
    {
      title: t("toolTable.availability"),
      dataIndex: "activation",
      width: 150,
      // `enabled` is admin intent; this is whether a run can actually call it.
      render: (activation: McpToolActivation) =>
        activation === "registered" ? (
          <Tag color="lime" data-testid="tool-availability-registered">
            {t("toolTable.activation.registered")}
          </Tag>
        ) : activation === "disabled" ? (
          <span className="text-xs text-zinc-600">{t("toolTable.activation.disabled")}</span>
        ) : (
          <Tooltip title={t(`toolTable.activationHint.${activation}`)}>
            <Tag color="warning" data-testid={`tool-availability-${activation}`}>
              {t(`toolTable.activation.${activation}`)}
            </Tag>
          </Tooltip>
        ),
    },
    {
      title: t("toolTable.permissions"),
      dataIndex: "requiredPermissions",
      render: (value: string[]) =>
        value.length ? (
          <div className="flex flex-wrap gap-1">
            {value.map((permission) => (
              <Tag key={permission} className="font-mono text-[11px]">
                {permission}
              </Tag>
            ))}
          </div>
        ) : (
          <span className="text-xs text-zinc-600">{t("toolTable.noPermissions")}</span>
        ),
    },
    {
      title: t("toolTable.enabled"),
      dataIndex: "enabled",
      width: 90,
      render: (enabled: boolean, tool) => (
        <Switch
          data-testid={`tool-enabled-${tool.id}`}
          size="small"
          checked={enabled}
          disabled={!access.canManage}
          onChange={(value) => void toggleTool(tool, { enabled: value })}
        />
      ),
    },
  ];

  return (
    <main className="agentmix-grid min-h-[calc(100dvh-3.5rem)]">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <section className="mb-8 flex flex-col justify-between gap-5 md:flex-row md:items-end">
          <div>
            <p className="m-0 font-mono text-xs tracking-[0.26em] text-[#b8f500] uppercase">
              {t("page.eyebrow")}
            </p>
            <h1 className="mb-0 mt-3 text-4xl font-semibold tracking-[-0.045em]">{t("page.title")}</h1>
            <p className="mb-0 mt-3 max-w-2xl text-sm leading-6 text-zinc-500">{t("page.description")}</p>
          </div>
          {access.canManage ? (
            <Button data-testid="create-server" type="primary" size="large" icon={<PlusOutlined />} onClick={openCreate}>
              {t("page.newServer")}
            </Button>
          ) : null}
        </section>

        {error ? <Alert className="mb-5" type="error" showIcon title={error} closable onClose={() => setError(null)} /> : null}
        {notice ? (
          <Alert
            className="mb-5"
            type={notice.type}
            showIcon
            title={notice.message}
            closable
            onClose={() => setNotice(null)}
          />
        ) : null}

        <section className="border border-white/10 bg-[#0d1011]/95">
          <div className="grid gap-4 border-b border-white/10 p-4 sm:grid-cols-3">
            <div>
              <p className="m-0 font-mono text-[10px] tracking-[0.18em] text-zinc-600 uppercase">{t("stats.servers")}</p>
              <p className="mb-0 mt-1 text-xl text-zinc-100">{servers.length}</p>
            </div>
            <div>
              <p className="m-0 font-mono text-[10px] tracking-[0.18em] text-zinc-600 uppercase">{t("stats.active")}</p>
              <p className="mb-0 mt-1 text-xl text-[#caff24]">
                {servers.filter((server) => server.status === "active").length}
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <SafetyOutlined className="text-[#b8f500]" /> {t("stats.secretsEnvOnly")}
            </div>
          </div>
          <Table<McpServer> rowKey="id" columns={columns} dataSource={servers} pagination={false} scroll={{ x: 980 }} />
        </section>
      </div>

      <Drawer
        destroyOnHidden
        size={560}
        open={drawerOpen}
        title={selected ? t("drawer.editTitle", { slug: selected.slug }) : t("drawer.createTitle")}
        onClose={() => setDrawerOpen(false)}
      >
        {error ? <Alert className="mb-5" type="error" showIcon title={error} /> : null}
        <Form<ServerFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          // Validate on submit, not on change: a change-triggered pass called
          // onFinish mid-typing, which saved half a credential pair.
          validateTrigger="onSubmit"
          onFinish={(values) => void submit(values)}
        >
          <Form.Item
            name="slug"
            label={t("form.slugLabel")}
            rules={[
              { required: true, message: t("form.slugRequired") },
              { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: t("form.slugPattern") },
              { min: 3, max: 64, message: t("form.slugLength") },
            ]}
          >
            <Input data-testid="server-slug" disabled={Boolean(selected)} placeholder={t("form.slugPlaceholder")} />
          </Form.Item>
          <Form.Item name="name" label={t("form.nameLabel")} rules={[{ required: true }, { max: 120 }]}>
            <Input data-testid="server-name" placeholder={t("form.namePlaceholder")} />
          </Form.Item>
          <Form.Item
            name="endpointUrl"
            label={t("form.endpointLabel")}
            rules={[
              { required: true, message: t("form.endpointRequired") },
              { pattern: /^https?:\/\/\S+$/i, message: t("form.endpointPattern") },
            ]}
          >
            <Input data-testid="server-endpoint" placeholder="https://mcp.example.com/mcp" autoComplete="off" />
          </Form.Item>
          <Form.Item name="description" label={t("form.descriptionLabel")} rules={[{ max: 1000 }]}>
            <Input.TextArea rows={3} placeholder={t("form.descriptionPlaceholder")} />
          </Form.Item>
          <div className="grid grid-cols-2 gap-3">
            <Form.Item
              name="authHeaderName"
              label={t("form.authHeaderLabel")}
              rules={[{ pattern: /^[A-Za-z0-9-]{1,100}$/, message: t("form.authHeaderPattern") }]}
            >
              <Input placeholder="Authorization" autoComplete="off" disabled={clearAuth} />
            </Form.Item>
            <Form.Item
              name="authEnvVar"
              label={t("form.authEnvVarLabel")}
              tooltip={t("form.authEnvVarTooltip")}
              rules={[{ pattern: /^[A-Z][A-Z0-9_]*$/, message: t("form.authEnvVarPattern") }]}
            >
              <Input placeholder="MCP_GITHUB_TOKEN" autoComplete="off" disabled={clearAuth} />
            </Form.Item>
          </div>
          {selected ? (
            <div className="mb-6 -mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
              {serverHasAuth(selected) ? (
                <>
                  <span>{t("form.authStoredHint", { envVar: selected.authEnvVar ?? "" })}</span>
                  <Button
                    data-testid="toggle-clear-auth"
                    type="link"
                    size="small"
                    danger={!clearAuth}
                    onClick={() => {
                      setClearAuth((current) => !current);
                      form.setFieldsValue({ authHeaderName: "", authEnvVar: "" });
                    }}
                  >
                    {clearAuth ? t("form.authClearCancel") : t("form.authClearAction")}
                  </Button>
                </>
              ) : (
                <span>{t("form.authAbsentHint")}</span>
              )}
            </div>
          ) : null}
          {clearAuth ? (
            <Alert
              className="mb-5"
              type="warning"
              showIcon
              title={t("form.authClearWarning")}
            />
          ) : null}
          {selected ? (
            <Form.Item name="status" label={t("form.statusLabel")} rules={[{ required: true }]}>
              <Select
                options={[
                  { label: t("form.statusActive"), value: "active" },
                  { label: t("form.statusDisabled"), value: "disabled" },
                ]}
              />
            </Form.Item>
          ) : null}
          <div className="mt-7 flex justify-end gap-3">
            <Button onClick={() => setDrawerOpen(false)}>{t("buttons.cancel")}</Button>
            <Button data-testid="submit-server" type="primary" htmlType="submit" loading={saving}>
              {selected ? t("buttons.saveServer") : t("buttons.createServer")}
            </Button>
          </div>
        </Form>
      </Drawer>

      <Drawer
        destroyOnHidden
        size={720}
        open={Boolean(toolsFor)}
        title={toolsFor ? t("toolDrawer.title", { name: toolsFor.name }) : ""}
        onClose={() => setToolsFor(null)}
      >
        <Alert className="mb-5" type="info" showIcon title={t("toolDrawer.discoveryHint")} />
        {unusableTools.length ? (
          <Alert
            className="mb-5"
            type="warning"
            showIcon
            data-testid="tools-unusable-warning"
            title={t("toolDrawer.unusableTitle", { count: unusableTools.length, total: tools.length })}
            description={t("toolDrawer.unusableDetail")}
          />
        ) : null}
        <Table<McpTool>
          rowKey="id"
          size="small"
          loading={toolsLoading}
          columns={toolColumns}
          dataSource={tools}
          pagination={false}
        />
      </Drawer>
    </main>
  );
}
