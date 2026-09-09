"use client";

import { EyeOutlined, FileSearchOutlined, LockOutlined, MessageOutlined, SafetyOutlined } from "@ant-design/icons";
import { Alert, Button, Descriptions, Drawer, Empty, Table, Tabs, Tag, Typography, type TableProps } from "antd";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { SafeMarkdown } from "../chat/safe-markdown";
import type { ConversationMessage } from "../chat/types";
import { normalizeConversationAuditDetail, type ConversationAuditApiDetail } from "./normalize";
import type {
  AuditEvent,
  ConversationAuditDetail,
  ConversationAuditMessagesResponse,
  ConversationAuditSummary,
  PaginatedResponse,
} from "./types";

interface AuditConsoleProps {
  events: PaginatedResponse<AuditEvent> | null;
  conversations: PaginatedResponse<ConversationAuditSummary> | null;
  canReadContent: boolean;
}

const SENSITIVE_KEY = /(prompt|response|content|system.?prompt|tool.?result|headers?|authorization|credential|secret|api.?key)/i;

function sanitizedMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizedMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .map(([key, nested]) => [key, sanitizedMetadata(nested)]),
  );
}

function AuditMessage({ message, dateFormatter }: { message: ConversationMessage; dateFormatter: Intl.DateTimeFormat }) {
  return (
    <article className="border border-white/10 bg-black/20 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <Tag color={message.role === "assistant" ? "lime" : "default"}>{message.role.toUpperCase()}</Tag>
        <span className="font-mono text-[10px] text-zinc-600">{dateFormatter.format(new Date(message.createdAt))}</span>
      </div>
      {message.role === "assistant" ? (
        <SafeMarkdown content={message.content} />
      ) : (
        <p className="m-0 whitespace-pre-wrap text-sm leading-7 text-zinc-300">{message.content}</p>
      )}
    </article>
  );
}

export function AuditConsole({ events, conversations, canReadContent }: AuditConsoleProps) {
  const t = useTranslations("audit");
  const locale = useLocale();
  const router = useRouter();
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZone: "UTC",
      }),
    [locale],
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selected, setSelected] = useState<ConversationAuditDetail | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drawerOpenRef = useRef(false);
  const activeConversationIdRef = useRef<string | null>(null);
  const detailGenerationRef = useRef(0);
  const detailControllerRef = useRef<AbortController | null>(null);

  function invalidateDetailRequests() {
    detailGenerationRef.current += 1;
    detailControllerRef.current?.abort();
    detailControllerRef.current = null;
  }

  function beginDetailRequest(conversationId: string) {
    invalidateDetailRequests();
    drawerOpenRef.current = true;
    activeConversationIdRef.current = conversationId;
    const controller = new AbortController();
    detailControllerRef.current = controller;
    return { controller, generation: detailGenerationRef.current, conversationId };
  }

  function isCurrentDetailRequest(generation: number, conversationId: string) {
    return (
      generation === detailGenerationRef.current &&
      drawerOpenRef.current &&
      activeConversationIdRef.current === conversationId
    );
  }

  function closeDrawer() {
    drawerOpenRef.current = false;
    activeConversationIdRef.current = null;
    invalidateDetailRequests();
    setLoadingDetail(false);
    setDrawerOpen(false);
  }

  useEffect(() => () => {
    detailControllerRef.current?.abort();
  }, []);

  function usageLabel(usage: ConversationAuditSummary["usage"]) {
    if (!usage) return "—";
    const total = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    return total ? t("conversations.usageTokens", { total: total.toLocaleString(locale) }) : "—";
  }

  function navigatePage(kind: "events" | "conversations", page: number) {
    const params = new URLSearchParams();
    const eventsPage = kind === "events" ? page : events?.page ?? 1;
    const conversationsPage = kind === "conversations" ? page : conversations?.page ?? 1;
    if (events && eventsPage > 1) params.set("eventsPage", String(eventsPage));
    if (conversations && conversationsPage > 1) {
      params.set("conversationsPage", String(conversationsPage));
    }
    router.push(params.size ? `/audit?${params}` : "/audit");
  }

  async function openConversation(conversation: ConversationAuditSummary) {
    const { controller, generation, conversationId } = beginDetailRequest(conversation.id);
    setDrawerOpen(true);
    setSelected(null);
    setMessages([]);
    setError(null);
    setLoadingDetail(true);
    try {
      const detailRequest = fetch(`/api/audit/conversations/${conversation.id}`, {
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
      });
      const messageRequest = canReadContent
        ? fetch(`/api/audit/conversations/${conversation.id}/messages`, {
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
          })
        : null;
      const [detailResponse, messagesResponse] = await Promise.all([detailRequest, messageRequest]);
      if (!isCurrentDetailRequest(generation, conversationId)) return;
      if (!detailResponse.ok) throw new Error("Conversation audit detail request failed");
      const rawDetail = (await detailResponse.json()) as ConversationAuditDetail | ConversationAuditApiDetail;
      if (messagesResponse) {
        if (!messagesResponse.ok) throw new Error("Conversation content request failed");
        const body = (await messagesResponse.json()) as ConversationAuditMessagesResponse | ConversationMessage[];
        if (!isCurrentDetailRequest(generation, conversationId)) return;
        setMessages(Array.isArray(body) ? body : body.items);
      }
      setSelected(normalizeConversationAuditDetail(rawDetail));
    } catch {
      if (!isCurrentDetailRequest(generation, conversationId)) return;
      setError(t("errors.loadConversation"));
    } finally {
      if (isCurrentDetailRequest(generation, conversationId)) setLoadingDetail(false);
    }
  }

  const eventColumns: TableProps<AuditEvent>["columns"] = [
    {
      title: t("events.columns.time"),
      dataIndex: "createdAt",
      width: 190,
      render: (value: string) => <span className="font-mono text-xs text-zinc-500">{dateFormatter.format(new Date(value))}</span>,
    },
    {
      title: t("events.columns.action"),
      dataIndex: "action",
      render: (value: string) => <span className="font-mono text-xs text-zinc-200">{value}</span>,
    },
    {
      title: t("events.columns.actor"),
      key: "actor",
      render: (_, event) => (
          <div>
          <div className="text-sm text-zinc-300">{event.actor?.displayName ?? event.actor?.username ?? event.actorSubjectId ?? t("events.system")}</div>
          <div className="font-mono text-[10px] text-zinc-700">{event.actor?.id ?? event.actorSubjectId ?? "—"}</div>
        </div>
      ),
    },
    {
      title: t("events.columns.resource"),
      key: "resource",
      render: (_, event) => (
        <div>
          <div className="text-xs text-zinc-400">{event.resourceType}</div>
          <div className="font-mono text-[10px] text-zinc-700">{event.resourceId ?? "—"}</div>
        </div>
      ),
    },
    {
      title: t("events.columns.outcome"),
      dataIndex: "outcome",
      width: 110,
      render: (value: string) => <Tag color={value === "success" ? "lime" : "error"}>{value.toUpperCase()}</Tag>,
    },
    {
      title: t("events.columns.metadata"),
      dataIndex: "metadata",
      width: 230,
      render: (value: Record<string, unknown> | null) => (
        <Typography.Text ellipsis={{ tooltip: JSON.stringify(sanitizedMetadata(value ?? {})) }} className="max-w-52 font-mono text-[10px] text-zinc-600">
          {JSON.stringify(sanitizedMetadata(value ?? {}))}
        </Typography.Text>
      ),
    },
  ];

  const conversationColumns: TableProps<ConversationAuditSummary>["columns"] = [
    {
      title: t("conversations.columns.conversation"),
      key: "conversation",
      render: (_, item) => (
        <div className="min-w-44">
          <div className="text-sm font-medium text-zinc-200">{t("conversations.recordName")}</div>
          <div className="mt-1 font-mono text-[10px] text-zinc-700">{item.id}</div>
        </div>
      ),
    },
    {
      title: t("conversations.columns.actor"),
      key: "actor",
      render: (_, item) => item.actor?.displayName ?? item.actor?.username ?? item.actorSubjectId ?? "—",
    },
    {
      title: t("conversations.columns.agentModel"),
      key: "runtime",
      render: (_, item) => {
        const model = item.model ?? item.modelProfile;
        return (
          <div>
            <div className="text-sm text-zinc-300">{item.agent?.name ?? item.agentId ?? "—"}</div>
            <div className="font-mono text-[10px] text-zinc-600">{model?.modelId ?? model?.key ?? "—"}</div>
          </div>
        );
      },
    },
    {
      title: t("conversations.columns.status"),
      dataIndex: "status",
      width: 115,
      render: (value: string) => <Tag color={value === "completed" || value === "active" ? "lime" : value === "failed" ? "error" : "default"}>{value.toUpperCase()}</Tag>,
    },
    {
      title: t("conversations.columns.usage"),
      dataIndex: "usage",
      width: 130,
      render: (value: ConversationAuditSummary["usage"]) => <span className="font-mono text-xs text-zinc-500">{usageLabel(value)}</span>,
    },
    {
      title: t("conversations.columns.updated"),
      dataIndex: "updatedAt",
      width: 180,
      render: (value: string) => <span className="font-mono text-xs text-zinc-500">{dateFormatter.format(new Date(value))}</span>,
    },
    {
      title: "",
      key: "action",
      width: 90,
      render: (_, item) => <Button data-testid={`audit-conversation-${item.id}`} type="text" icon={<EyeOutlined />} onClick={() => void openConversation(item)}>{t("conversations.columns.inspect")}</Button>,
    },
  ];

  const tabs = [
    events ? {
      key: "events",
      label: <span><SafetyOutlined /> {t("tabs.events")}</span>,
      children: (
        <section data-testid="audit-events-section" className="border border-white/10 bg-[#0d1011]/95">
          <div className="border-b border-white/10 p-4 font-mono text-xs text-zinc-600">{t("events.total", { total: events.total })}</div>
          <Table<AuditEvent>
            rowKey="id"
            columns={eventColumns}
            dataSource={events.items}
            scroll={{ x: 1100 }}
            pagination={{
              current: events.page,
              pageSize: events.pageSize,
              total: events.total,
              showSizeChanger: false,
              showTotal: (total) => t("events.paginationTotal", { total }),
              onChange: (page) => navigatePage("events", page),
            }}
            locale={{ emptyText: <Empty description={t("events.empty")} /> }}
          />
        </section>
      ),
    } : null,
    conversations ? {
      key: "conversations",
      label: <span><MessageOutlined /> {t("tabs.conversations")}</span>,
      children: (
        <section data-testid="audit-conversations-section" className="border border-white/10 bg-[#0d1011]/95">
          <div className="flex flex-col justify-between gap-2 border-b border-white/10 p-4 sm:flex-row sm:items-center">
            <span className="font-mono text-xs text-zinc-600">{t("conversations.total", { total: conversations.total })}</span>
            <span className="flex items-center gap-2 text-xs text-zinc-500"><LockOutlined /> {t("conversations.contentPermission", { value: canReadContent ? t("conversations.contentGranted") : t("conversations.contentMetadataOnly") })}</span>
          </div>
          <Table<ConversationAuditSummary>
            rowKey="id"
            columns={conversationColumns}
            dataSource={conversations.items}
            scroll={{ x: 1050 }}
            pagination={{
              current: conversations.page,
              pageSize: conversations.pageSize,
              total: conversations.total,
              showSizeChanger: false,
              showTotal: (total) => t("conversations.paginationTotal", { total }),
              onChange: (page) => navigatePage("conversations", page),
            }}
            locale={{ emptyText: <Empty description={t("conversations.empty")} /> }}
          />
        </section>
      ),
    } : null,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));

  return (
    <main className="agentmix-grid min-h-[calc(100dvh-3.5rem)]">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <section className="mb-8">
          <p className="m-0 font-mono text-xs tracking-[0.26em] text-[#b8f500] uppercase">{t("page.eyebrow")}</p>
          <h1 className="mb-0 mt-3 text-4xl font-semibold tracking-[-0.045em]">{t("page.title")}</h1>
          <p className="mb-0 mt-3 max-w-2xl text-sm leading-6 text-zinc-500">
            {t("page.intro")}
          </p>
        </section>
        <Tabs items={tabs} />
      </div>

      <Drawer size={720} open={drawerOpen} title={t("drawer.title")} onClose={closeDrawer}>
        {error ? <Alert className="mb-5" type="error" showIcon title={error} /> : null}
        {loadingDetail ? <div className="py-20 text-center text-zinc-500">{t("drawer.loading")}</div> : selected ? (
          <>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label={t("drawer.fields.conversationId")} span={2}><Typography.Text copyable className="font-mono text-xs">{selected.id}</Typography.Text></Descriptions.Item>
              <Descriptions.Item label={t("drawer.fields.actor")}>{selected.actor?.displayName ?? selected.actor?.username ?? selected.actorSubjectId ?? "—"}</Descriptions.Item>
              <Descriptions.Item label={t("drawer.fields.agent")}>{selected.agent?.name ?? selected.agentId ?? "—"}</Descriptions.Item>
              <Descriptions.Item label={t("drawer.fields.model")} span={2}>{selected.model?.modelId ?? selected.model?.key ?? selected.modelProfile?.modelId ?? selected.modelProfile?.key ?? "—"}</Descriptions.Item>
              <Descriptions.Item label={t("drawer.fields.status")}>{selected.status}</Descriptions.Item>
              <Descriptions.Item label={t("drawer.fields.usage")}>{usageLabel(selected.usage)}</Descriptions.Item>
              <Descriptions.Item label={t("drawer.fields.created")}>{dateFormatter.format(new Date(selected.createdAt))}</Descriptions.Item>
              <Descriptions.Item label={t("drawer.fields.deleted")}>{selected.deletedAt ? dateFormatter.format(new Date(selected.deletedAt)) : t("drawer.fields.deletedNo")}</Descriptions.Item>
            </Descriptions>

            <div className="mb-4 mt-8 flex items-center gap-2">
              <FileSearchOutlined className="text-[#b8f500]" />
              <h2 className="m-0 text-base font-medium">{t("drawer.contentHeading")}</h2>
            </div>
            {canReadContent ? (
              messages.length ? <div className="space-y-3">{messages.map((message) => <AuditMessage key={message.id} message={message} dateFormatter={dateFormatter} />)}</div> : <Empty description={t("drawer.emptyContent")} />
            ) : (
              <Alert
                type="warning"
                showIcon
                icon={<LockOutlined />}
                title={t("drawer.protected.title")}
                description={t("drawer.protected.description")}
              />
            )}
          </>
        ) : null}
      </Drawer>
    </main>
  );
}
