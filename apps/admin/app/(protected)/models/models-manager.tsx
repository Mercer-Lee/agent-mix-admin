"use client";

import {
  ApiOutlined,
  CheckCircleOutlined,
  EditOutlined,
  ExperimentOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { Alert, Button, Drawer, Form, Input, Select, Table, Tag, Tooltip, type TableProps } from "antd";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { checkModelAction, createModelAction, updateModelAction } from "./actions";
import type {
  ModelAccess,
  ModelCheckStatus,
  ModelCheckSummary,
  ModelProfile,
  ModelProfileListResponse,
  ModelProfileMutationInput,
} from "./types";

interface ModelsManagerProps {
  initialData: ModelProfileListResponse;
  access: ModelAccess;
}

interface ModelFormValues extends ModelProfileMutationInput {
  key: string;
  status: "active" | "disabled";
}

const CHECK_TAG: Record<ModelCheckStatus, { color: string; label: string }> = {
  queued: { color: "default", label: "QUEUED" },
  running: { color: "processing", label: "CHECKING" },
  succeeded: { color: "lime", label: "HEALTHY" },
  failed: { color: "error", label: "FAILED" },
};

function CheckState({ check }: { check: ModelCheckSummary | null }) {
  const t = useTranslations("models");
  if (!check) return <span className="font-mono text-xs text-zinc-600">{t("table.neverChecked")}</span>;
  const meta = CHECK_TAG[check.status];
  return (
    <div>
      <Tag color={meta.color}>{meta.label}</Tag>
      {check.latencyMs !== null ? (
        <span className="ml-1 font-mono text-xs text-zinc-500">{check.latencyMs}ms</span>
      ) : null}
      {check.status === "failed" && check.errorCode ? (
        <div className="mt-1 font-mono text-[11px] text-red-300/70">{check.errorCode}</div>
      ) : null}
    </div>
  );
}

async function waitForCheck(check: ModelCheckSummary): Promise<ModelCheckSummary> {
  let current = check;
  for (let attempt = 0; attempt < 30 && ["queued", "running"].includes(current.status); attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    const response = await fetch(`/api/model-checks/${current.id}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Model check status request failed");
    current = (await response.json()) as ModelCheckSummary;
  }
  return current;
}

export function ModelsManager({ initialData, access }: ModelsManagerProps) {
  const t = useTranslations("models");
  const router = useRouter();
  const [form] = Form.useForm<ModelFormValues>();
  const [models, setModels] = useState(initialData.items);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selected, setSelected] = useState<ModelProfile | null>(null);
  const [saving, setSaving] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeCount = useMemo(() => models.filter((model) => model.status === "active").length, [models]);

  function openCreate() {
    setSelected(null);
    setError(null);
    form.setFieldsValue({ key: "", name: "", description: "", modelId: "", status: "active" });
    setDrawerOpen(true);
  }

  function openEdit(model: ModelProfile) {
    setSelected(model);
    setError(null);
    form.setFieldsValue({
      key: model.key,
      name: model.name,
      description: model.description,
      modelId: model.modelId,
      status: model.status,
    });
    setDrawerOpen(true);
  }

  async function submit(values: ModelFormValues) {
    setSaving(true);
    setError(null);
    const result = selected
      ? await updateModelAction(selected.id, values)
      : await createModelAction(values);
    setSaving(false);
    if (!result.ok || !result.data) {
      setError(result.error ?? t("errors.saveFailed"));
      return;
    }
    setModels((current) => {
      const exists = current.some((model) => model.id === result.data!.id);
      return exists
        ? current.map((model) => model.id === result.data!.id
            ? { ...result.data!, lastCheck: result.data!.lastCheck ?? model.lastCheck }
            : model)
        : [result.data!, ...current];
    });
    setDrawerOpen(false);
    router.refresh();
  }

  async function runCheck(model: ModelProfile) {
    setCheckingId(model.id);
    setError(null);
    const result = await checkModelAction(model.id);
    if (!result.ok || !result.data) {
      setError(result.error ?? t("errors.checkQueueFailed"));
      setCheckingId(null);
      return;
    }
    setModels((current) =>
      current.map((item) => (item.id === model.id ? { ...item, lastCheck: result.data! } : item)),
    );
    try {
      const finalCheck = await waitForCheck(result.data);
      setModels((current) =>
        current.map((item) => (item.id === model.id ? { ...item, lastCheck: finalCheck } : item)),
      );
    } catch {
      setError(t("errors.checkStatusUnavailable"));
    } finally {
      setCheckingId(null);
      router.refresh();
    }
  }

  const columns: TableProps<ModelProfile>["columns"] = [
    {
      title: t("table.profile"),
      key: "profile",
      render: (_, model) => (
        <div className="min-w-44">
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm font-semibold text-zinc-100 hover:text-[#caff24]"
            onClick={() => openEdit(model)}
          >
            {model.name}
          </button>
          <div className="mt-1 font-mono text-xs text-zinc-600">{model.key}</div>
        </div>
      ),
    },
    {
      title: t("table.modelId"),
      dataIndex: "modelId",
      render: (value: string) => <span className="font-mono text-xs text-zinc-300">{value}</span>,
    },
    {
      title: t("table.connection"),
      key: "connection",
      width: 190,
      render: (_, model) => (
        <Tooltip title={t("table.connectionTooltip")}>
          <span className="font-mono text-xs text-zinc-500">
            {model.provider} / {model.connection}
          </span>
        </Tooltip>
      ),
    },
    {
      title: t("table.lastCheck"),
      dataIndex: "lastCheck",
      width: 160,
      render: (value: ModelCheckSummary | null) => <CheckState check={value} />,
    },
    {
      title: t("table.status"),
      dataIndex: "status",
      width: 100,
      render: (status: ModelProfile["status"]) =>
        status === "active" ? <Tag color="lime">ACTIVE</Tag> : <Tag>DISABLED</Tag>,
    },
    {
      title: "",
      key: "actions",
      width: 190,
      render: (_, model) => (
        <div className="flex justify-end gap-1">
          {access.canTest ? (
            <Button
              data-testid={`check-model-${model.id}`}
              type="text"
              icon={<ExperimentOutlined />}
              loading={checkingId === model.id}
              onClick={() => void runCheck(model)}
            >
              {t("table.check")}
            </Button>
          ) : null}
          <Button
            data-testid={`edit-model-${model.id}`}
            type="text"
            icon={access.canUpdate ? <EditOutlined /> : <ApiOutlined />}
            onClick={() => openEdit(model)}
          >
            {access.canUpdate ? t("table.edit") : t("table.view")}
          </Button>
        </div>
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
            <p className="mb-0 mt-3 max-w-2xl text-sm leading-6 text-zinc-500">
              {t("page.description")}
            </p>
          </div>
          {access.canCreate ? (
            <Button data-testid="create-model" type="primary" size="large" icon={<PlusOutlined />} onClick={openCreate}>
              {t("page.newProfile")}
            </Button>
          ) : null}
        </section>

        {error ? <Alert className="mb-5" type="error" showIcon title={error} closable onClose={() => setError(null)} /> : null}

        <section className="border border-white/10 bg-[#0d1011]/95">
          <div className="grid gap-4 border-b border-white/10 p-4 sm:grid-cols-3">
            <div>
              <p className="m-0 font-mono text-[10px] tracking-[0.18em] text-zinc-600 uppercase">{t("stats.profiles")}</p>
              <p className="mb-0 mt-1 text-xl text-zinc-100">{models.length}</p>
            </div>
            <div>
              <p className="m-0 font-mono text-[10px] tracking-[0.18em] text-zinc-600 uppercase">{t("stats.enabled")}</p>
              <p className="mb-0 mt-1 text-xl text-[#caff24]">{activeCount}</p>
            </div>
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <SafetyCertificateOutlined className="text-[#b8f500]" /> {t("stats.secretsWorkerOnly")}
            </div>
          </div>
          <Table<ModelProfile>
            rowKey="id"
            columns={columns}
            dataSource={models}
            pagination={false}
            scroll={{ x: 920 }}
          />
        </section>
      </div>

      <Drawer
        destroyOnHidden
        size={560}
        open={drawerOpen}
        title={selected ? t("drawer.editTitle", { key: selected.key }) : t("drawer.createTitle")}
        onClose={() => setDrawerOpen(false)}
      >
        {error ? <Alert className="mb-5" type="error" showIcon title={error} /> : null}
        <Alert
          className="mb-6"
          type="info"
          showIcon
          title={t("drawer.connectionFixedTitle")}
          description={t("drawer.connectionFixedDescription")}
        />
        <Form<ModelFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          disabled={Boolean(selected && !access.canUpdate)}
          onFinish={(values) => void submit(values)}
        >
          <Form.Item
            name="key"
            label={t("form.keyLabel")}
            rules={[
              { required: true, message: t("form.keyRequired") },
              { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: t("form.keyPattern") },
              { min: 3, max: 64, message: t("form.keyLength") },
            ]}
          >
            <Input data-testid="model-key" disabled={Boolean(selected)} placeholder={t("form.keyPlaceholder")} />
          </Form.Item>
          <Form.Item name="name" label={t("form.nameLabel")} rules={[{ required: true }, { max: 120 }]}>
            <Input data-testid="model-name" placeholder={t("form.namePlaceholder")} />
          </Form.Item>
          <Form.Item name="modelId" label={t("form.modelIdLabel")} rules={[{ required: true }, { max: 200 }]}>
            <Input data-testid="model-id" placeholder={t("form.modelIdPlaceholder")} autoComplete="off" />
          </Form.Item>
          <Form.Item name="description" label={t("form.descriptionLabel")} rules={[{ max: 1000 }]}>
            <Input.TextArea rows={4} placeholder={t("form.descriptionPlaceholder")} />
          </Form.Item>
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
          {!selected || access.canUpdate ? (
            <div className="mt-7 flex justify-end gap-3">
              <Button onClick={() => setDrawerOpen(false)}>{t("buttons.cancel")}</Button>
              <Button data-testid="submit-model" type="primary" htmlType="submit" loading={saving}>
                {selected ? t("buttons.saveProfile") : t("buttons.createProfile")}
              </Button>
            </div>
          ) : null}
        </Form>
      </Drawer>
    </main>
  );
}
