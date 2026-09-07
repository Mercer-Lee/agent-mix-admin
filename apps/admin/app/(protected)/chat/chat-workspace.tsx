"use client";

import {
  CloseOutlined,
  DeleteOutlined,
  MenuOutlined,
  MessageOutlined,
  PlusOutlined,
  RobotOutlined,
  SendOutlined,
  StopOutlined,
  ToolOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { Button, Drawer, Empty, Input, Popconfirm, Select, Tag, Tooltip } from "antd";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  cancelRunAction,
  createConversationAction,
  deleteConversationAction,
  sendConversationMessageAction,
} from "./actions";
import { SafeMarkdown } from "./safe-markdown";
import type {
  AgentRun,
  AgentRunStatus,
  ChatAgent,
  ConversationDetailResponse,
  ConversationMessage,
  ConversationSummary,
  CreateConversationResponse,
} from "./types";

interface ChatWorkspaceProps {
  initialAgents: ChatAgent[];
  initialConversations: ConversationSummary[];
  initialDetail?: ConversationDetailResponse;
}

type StreamStatus = "idle" | "connecting" | "live" | "reconnecting" | "closed";

interface ToolActivity {
  key: string;
  name: string;
  status: "running" | "completed" | "failed";
}

interface StreamPayload {
  sequence?: number;
  attempt?: number;
  delta?: string;
  text?: string;
  name?: string;
  capabilityId?: string;
  capability?: string | { id?: string; name?: string };
  capabilityRequestId?: string;
  requestId?: string;
  run?: AgentRun;
  status?: AgentRunStatus;
  usage?: AgentRun["usage"];
  errorCode?: string | null;
  assistantMessage?: ConversationMessage | null;
  payload?: StreamPayload;
}

const TERMINAL_STATUSES: AgentRunStatus[] = ["completed", "failed", "canceled", "cancelled"];
const conversationDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "2-digit",
  timeZone: "UTC",
});

function idempotencyKey(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function eventPayload(event: MessageEvent<string>): StreamPayload {
  try {
    const parsed = JSON.parse(event.data) as StreamPayload;
    return parsed.payload ?? parsed;
  } catch {
    return {};
  }
}

function agentForConversation(conversation: ConversationSummary | null, agents: ChatAgent[]) {
  if (!conversation) return null;
  if (conversation.agent) return conversation.agent;
  return agents.find((agent) => agent.id === conversation.agentId) ?? null;
}

function RunBadge({ run, streamStatus }: { run: AgentRun | null; streamStatus: StreamStatus }) {
  if (!run) return <Tag>READY</Tag>;
  const canceled = run.status === "canceled" || run.status === "cancelled";
  const color =
    run.status === "completed"
      ? "lime"
      : run.status === "failed"
        ? "error"
        : canceled
          ? "default"
          : "processing";
  const suffix = streamStatus === "reconnecting" ? " / reconnecting" : "";
  return <Tag data-testid="run-badge" data-tone={color} color={color}>{`${run.status}${suffix}`.toUpperCase()}</Tag>;
}

function ToolActivityList({ activities }: { activities: ToolActivity[] }) {
  if (!activities.length) return null;
  return (
    <div className="mx-auto my-4 max-w-3xl space-y-2" aria-label="Tool activity">
      {activities.map((activity) => (
        <div key={activity.key} className="flex items-center justify-between gap-4 border border-white/10 bg-black/30 px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <ToolOutlined className="text-[#b8f500]" />
            <span className="font-mono">{activity.name}</span>
          </div>
          <Tag color={activity.status === "completed" ? "lime" : activity.status === "failed" ? "error" : "processing"}>
            {activity.status.toUpperCase()}
          </Tag>
        </div>
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: ConversationMessage }) {
  const assistant = message.role === "assistant";
  return (
    <article data-message-id={message.id} className={`mx-auto flex max-w-3xl gap-3 ${assistant ? "" : "flex-row-reverse"}`}>
      <div className={`grid h-8 w-8 shrink-0 place-items-center border ${assistant ? "border-[#b8f500]/30 bg-[#b8f500]/5 text-[#caff24]" : "border-white/10 bg-white/5 text-zinc-400"}`}>
        {assistant ? <RobotOutlined /> : <UserOutlined />}
      </div>
      <div className={`min-w-0 max-w-[calc(100%-3rem)] border px-4 py-3 ${assistant ? "border-white/10 bg-[#111415]" : "border-white/10 bg-white/[0.04]"}`}>
        <p className="m-0 font-mono text-[10px] tracking-[0.16em] text-zinc-600 uppercase">
          {assistant ? "Agent" : "You"}
        </p>
        {assistant ? (
          <SafeMarkdown content={message.content} />
        ) : (
          <p className="mb-0 mt-2 whitespace-pre-wrap text-sm leading-7 text-zinc-200">{message.content}</p>
        )}
      </div>
    </article>
  );
}

function ConversationSidebar({
  conversations,
  selectedId,
  onNavigate,
}: {
  conversations: ConversationSummary[];
  selectedId?: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-white/10 p-4">
        <Link
          href="/chat"
          onClick={onNavigate}
          className="flex items-center justify-center gap-2 border border-[#b8f500]/35 bg-[#b8f500]/10 px-3 py-2.5 text-sm font-medium text-[#caff24] no-underline hover:bg-[#b8f500]/15"
        >
          <PlusOutlined /> New conversation
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {conversations.length ? conversations.map((conversation) => {
          const active = conversation.id === selectedId;
          return (
            <Link
              key={conversation.id}
              href={`/chat/${conversation.id}`}
              onClick={onNavigate}
              className={`mb-1 block border px-3 py-3 no-underline transition-colors ${active ? "border-[#b8f500]/30 bg-[#b8f500]/8 text-zinc-100" : "border-transparent text-zinc-500 hover:border-white/10 hover:bg-white/[0.025] hover:text-zinc-300"}`}
            >
              <div className="truncate text-sm">{conversation.title || "Untitled conversation"}</div>
              <div className="mt-1 font-mono text-[10px] text-zinc-700">
                {conversationDateFormatter.format(new Date(conversation.updatedAt))}
              </div>
            </Link>
          );
        }) : (
          <div className="px-3 py-10 text-center text-xs text-zinc-700">No conversations yet</div>
        )}
      </div>
    </div>
  );
}

export function ChatWorkspace({ initialAgents, initialConversations, initialDetail }: ChatWorkspaceProps) {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const [conversations, setConversations] = useState(initialConversations);
  const [conversation, setConversation] = useState(initialDetail?.conversation ?? null);
  const [messages, setMessages] = useState(initialDetail?.messages ?? []);
  const [activeRun, setActiveRun] = useState(initialDetail?.activeRun ?? null);
  const [partialText, setPartialText] = useState("");
  const [toolActivities, setToolActivities] = useState<ToolActivity[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState(
    initialDetail?.conversation.agent?.id ?? initialDetail?.conversation.agentId ?? initialAgents[0]?.id ?? "",
  );
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("idle");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const lastSequenceRef = useRef(0);
  const partialTextRef = useRef("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const composingRef = useRef(false);
  const previousDetailRef = useRef(initialDetail);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const selectedAgent = agentForConversation(conversation, initialAgents) ?? initialAgents.find((agent) => agent.id === selectedAgentId) ?? null;
  const runIsActive = activeRun ? !TERMINAL_STATUSES.includes(activeRun.status) : false;

  function scrollToBottom() {
    const sentinel = bottomSentinelRef.current;
    // jsdom does not implement scrollIntoView; the follow behavior is a no-op there.
    if (sentinel && typeof sentinel.scrollIntoView === "function") {
      sentinel.scrollIntoView({ block: "end" });
    }
  }

  function handleScroll() {
    const container = scrollContainerRef.current;
    if (!container) return;
    atBottomRef.current =
      container.scrollHeight - container.scrollTop - container.clientHeight < 160;
  }

  // Land on the newest message when the conversation changes (including first mount).
  useEffect(() => {
    scrollToBottom();
  }, [conversation?.id]);

  // Follow streaming output only while the user has not scrolled away from the bottom.
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [messages.length, partialText, toolActivities.length]);

  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  useEffect(() => {
    const previousDetail = previousDetailRef.current;
    previousDetailRef.current = initialDetail;
    if (!initialDetail) {
      if (!previousDetail) return;
      setConversation(null);
      setMessages([]);
      setActiveRun(null);
      setSelectedAgentId(initialAgents[0]?.id ?? "");
      setPartialText("");
      partialTextRef.current = "";
      setToolActivities([]);
      lastSequenceRef.current = 0;
      return;
    }

    const changedConversation =
      Boolean(previousDetail) && previousDetail?.conversation.id !== initialDetail.conversation.id;
    setConversation(initialDetail.conversation);
    setMessages(initialDetail.messages);
    setActiveRun(initialDetail.activeRun);
    setSelectedAgentId(initialDetail.conversation.agent?.id ?? initialDetail.conversation.agentId ?? "");
    if (changedConversation || !initialDetail.activeRun) {
      setPartialText("");
      partialTextRef.current = "";
      setToolActivities([]);
      lastSequenceRef.current = 0;
    }
  }, [initialAgents, initialDetail]);

  useEffect(() => {
    // A different run id (including no run) must never inherit a pending stop request.
    setCancelRequested(false);
    if (!activeRun || TERMINAL_STATUSES.includes(activeRun.status)) {
      setStreamStatus(activeRun ? "closed" : "idle");
      return;
    }

    let disposed = false;

    function updateSequence(event: MessageEvent<string>, payload: StreamPayload) {
      const sequence = Number(event.lastEventId || payload.sequence || 0);
      if (Number.isFinite(sequence) && sequence > lastSequenceRef.current) lastSequenceRef.current = sequence;
    }

    function upsertTool(payload: StreamPayload, status: ToolActivity["status"]) {
      const capability = typeof payload.capability === "string"
        ? payload.capability
        : payload.capability?.name ?? payload.capability?.id;
      const key = payload.capabilityRequestId ?? payload.requestId ?? payload.capabilityId ?? capability ?? `tool-${lastSequenceRef.current}`;
      const name = payload.name ?? payload.capabilityId ?? capability ?? "users.search";
      setToolActivities((current) => {
        const exists = current.some((item) => item.key === key);
        return exists
          ? current.map((item) => (item.key === key ? { ...item, status, name } : item))
          : [...current, { key, name, status }];
      });
    }

    function appendAssistantMessage(payload: StreamPayload) {
      const supplied = payload.assistantMessage ?? payload.run?.assistantMessage;
      const content = supplied?.content ?? payload.text ?? partialTextRef.current;
      if (!content) return;
      const message: ConversationMessage = supplied ?? {
        id: `stream-${activeRun!.id}`,
        conversationId: activeRun!.conversationId,
        role: "assistant",
        content,
        createdAt: new Date().toISOString(),
        runId: activeRun!.id,
      };
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
      partialTextRef.current = "";
      setPartialText("");
    }

    function finish(status: AgentRunStatus, payload: StreamPayload) {
      if (status === "completed") appendAssistantMessage(payload);
      setActiveRun((current) => current ? {
        ...current,
        ...(payload.run ?? {}),
        status,
        usage: payload.usage ?? payload.run?.usage ?? current.usage,
        errorCode: payload.errorCode ?? payload.run?.errorCode ?? current.errorCode,
      } : current);
      setCancelRequested(false);
      setStreamStatus("closed");
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      if (status === "failed") setError(`Generation failed${payload.errorCode ? ` (${payload.errorCode})` : ""}.`);
      routerRef.current.refresh();
    }

    function connect() {
      if (disposed) return;
      setStreamStatus("connecting");
      const source = new EventSource(`/api/runs/${activeRun!.id}/events`, { withCredentials: true });
      eventSourceRef.current = source;
      source.onopen = () => {
        setStreamStatus("live");
      };

      const on = (name: string, handler: (payload: StreamPayload) => void) => {
        source.addEventListener(name, (event) => {
          const message = event as MessageEvent<string>;
          const payload = eventPayload(message);
          updateSequence(message, payload);
          handler(payload);
        });
      };

      on("run.started", (payload) => {
        setActiveRun((current) => current ? { ...current, status: "running", attempt: payload.attempt ?? current.attempt } : current);
      });
      on("reset", (payload) => {
        partialTextRef.current = "";
        setPartialText("");
        setToolActivities([]);
        setActiveRun((current) => current ? { ...current, attempt: payload.attempt ?? current.attempt } : current);
      });
      on("text.delta", (payload) => {
        const delta = payload.delta ?? payload.text ?? "";
        if (!delta) return;
        partialTextRef.current += delta;
        setPartialText(partialTextRef.current);
      });
      on("capability.started", (payload) => upsertTool(payload, "running"));
      on("capability.completed", (payload) => upsertTool(payload, "completed"));
      on("capability.failed", (payload) => upsertTool(payload, "failed"));
      on("run.completed", (payload) => finish("completed", payload));
      on("run.failed", (payload) => finish("failed", payload));
      on("run.cancelled", (payload) => finish("canceled", payload));
      on("snapshot", (payload) => {
        const snapshotRun = payload.run;
        const text = payload.text ?? payload.assistantMessage?.content ?? snapshotRun?.assistantMessage?.content;
        if (text && !partialTextRef.current) {
          partialTextRef.current = text;
          setPartialText(text);
        }
        const status = snapshotRun?.status ?? payload.status;
        if (status && TERMINAL_STATUSES.includes(status)) finish(status, payload);
      });

      source.onerror = () => {
        if (disposed) return;
        setStreamStatus("reconnecting");
        // Keep this EventSource alive. The browser reconnects it using the server-provided
        // retry interval and automatically sends Last-Event-ID, preserving the durable cursor.
      };
    }

    lastSequenceRef.current = 0;
    connect();
    return () => {
      disposed = true;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [activeRun?.id]);

  const agentOptions = useMemo(() => initialAgents.map((agent) => ({
    value: agent.id,
    label: `${agent.name} / ${agent.slug}`,
  })), [initialAgents]);

  async function sendMessage() {
    const content = composer.trim();
    if (!content || sending || runIsActive || !selectedAgentId) return;
    setSending(true);
    setError(null);
    setPartialText("");
    partialTextRef.current = "";
    setToolActivities([]);
    lastSequenceRef.current = 0;
    const optimistic: ConversationMessage = {
      id: `local-${idempotencyKey()}`,
      conversationId: conversation?.id ?? "pending",
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    setComposer("");
    setMessages((current) => [...current, optimistic]);

    const requestKey = idempotencyKey();
    const result = conversation
      ? await sendConversationMessageAction({ conversationId: conversation.id, content, idempotencyKey: requestKey })
      : await createConversationAction({ agentId: selectedAgentId, content, idempotencyKey: requestKey });
    setSending(false);
    if (!result.ok || !result.data) {
      setMessages((current) => current.filter((message) => message.id !== optimistic.id));
      setComposer(content);
      setError(result.error ?? "Unable to send the message.");
      return;
    }

    if ("conversation" in result.data) {
      const created = result.data as CreateConversationResponse;
      const nextConversation = created.conversation;
      setConversation(nextConversation);
      setConversations((current) => [nextConversation, ...current.filter((item) => item.id !== nextConversation.id)]);
      setMessages((current) => current.map((message) => message.id === optimistic.id ? { ...message, conversationId: nextConversation.id } : message));
      setActiveRun(created.run);
      router.push(`/chat/${nextConversation.id}`);
    } else {
      setActiveRun(result.data.run);
    }
  }

  async function cancelRun() {
    if (!activeRun || cancelRequested) return;
    setCancelRequested(true);
    setError(null);
    const result = await cancelRunAction(activeRun.id);
    if (!result.ok) {
      setCancelRequested(false);
      setError(result.error ?? "Unable to stop the run.");
    }
  }

  async function deleteConversation() {
    if (!conversation) return;
    const result = await deleteConversationAction(conversation.id);
    if (!result.ok) {
      setError(result.error ?? "Unable to remove the conversation.");
      return;
    }
    eventSourceRef.current?.close();
    setConversations((current) => current.filter((item) => item.id !== conversation.id));
    setConversation(null);
    setMessages([]);
    setActiveRun(null);
    setPartialText("");
    setCancelRequested(false);
    router.push("/chat");
  }

  function composerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (composingRef.current || event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  let emptyState: ReactNode = null;
  if (!initialAgents.length) {
    emptyState = <Empty description="No governed Agent is currently available to you" />;
  } else if (!conversation && !messages.length) {
    emptyState = (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center border border-[#b8f500]/30 bg-[#b8f500]/5 text-2xl text-[#caff24]">
          <RobotOutlined />
        </div>
        <p className="mt-6 font-mono text-xs tracking-[0.25em] text-[#b8f500] uppercase">Runtime workbench</p>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em]">Start a governed run</h1>
        <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-zinc-500">
          Every message creates an immutable execution snapshot, streams through BullMQ and records metadata for audit.
        </p>
      </div>
    );
  }

  return (
    <main className="flex min-h-0 flex-1 overflow-hidden bg-[#090b0c]">
      <aside className="hidden w-72 shrink-0 border-r border-white/10 bg-[#0d1011] md:block">
        <ConversationSidebar conversations={conversations} selectedId={conversation?.id} />
      </aside>

      <Drawer
        placement="left"
        size={300}
        open={mobileSidebarOpen}
        title="Conversations"
        onClose={() => setMobileSidebarOpen(false)}
        styles={{ body: { padding: 0 } }}
      >
        <ConversationSidebar
          conversations={conversations}
          selectedId={conversation?.id}
          onNavigate={() => setMobileSidebarOpen(false)}
        />
      </Drawer>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-[#0d1011]/95 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Button className="md:hidden" type="text" icon={<MenuOutlined />} aria-label="Open conversations" onClick={() => setMobileSidebarOpen(true)} />
            <div className="min-w-0">
              <p className="m-0 truncate text-sm font-medium text-zinc-200">
                {conversation?.title || selectedAgent?.name || "New conversation"}
              </p>
              <p className="m-0 mt-0.5 truncate font-mono text-[10px] tracking-[0.14em] text-zinc-600 uppercase">
                {selectedAgent ? `${selectedAgent.slug} / ${selectedAgent.id}` : "No runtime selected"}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <RunBadge run={activeRun} streamStatus={streamStatus} />
            {conversation ? (
              <Popconfirm
                title="Remove this conversation?"
                description="It will be hidden from your history but retained for authorized audit."
                okText="Remove"
                okButtonProps={{ danger: true }}
                onConfirm={() => void deleteConversation()}
              >
                <Tooltip title="Remove conversation">
                  <Button danger type="text" icon={<DeleteOutlined />} aria-label="Remove conversation" />
                </Tooltip>
              </Popconfirm>
            ) : null}
          </div>
        </header>

        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="agentmix-grid min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6"
        >
          {emptyState}
          {messages.length ? (
            <div className="space-y-5">
              {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
            </div>
          ) : null}
          <ToolActivityList activities={toolActivities} />
          {partialText ? (
            <article className="mx-auto mt-5 flex max-w-3xl gap-3" data-testid="streaming-assistant-message">
              <div className="grid h-8 w-8 shrink-0 place-items-center border border-[#b8f500]/30 bg-[#b8f500]/5 text-[#caff24]">
                <RobotOutlined />
              </div>
              <div className="min-w-0 flex-1 border border-[#b8f500]/20 bg-[#111415] px-4 py-3">
                <p className="m-0 flex items-center gap-2 font-mono text-[10px] tracking-[0.16em] text-[#b8f500] uppercase">
                  <span className="agentmix-signal h-1.5 w-1.5 bg-[#b8f500]" /> Streaming
                </p>
                <SafeMarkdown content={partialText} />
              </div>
            </article>
          ) : null}
          {activeRun?.status === "failed" ? (
            <div className="mx-auto mt-5 max-w-3xl border border-red-400/20 bg-red-400/5 px-4 py-3 text-sm text-red-300">
              The runtime stopped without a terminal response. Error code: {activeRun.errorCode ?? "RUN_FAILED"}
            </div>
          ) : null}
          <div ref={bottomSentinelRef} aria-hidden="true" className="h-0" />
        </div>

        <footer className="shrink-0 border-t border-white/10 bg-[#0d1011] p-3 sm:p-4">
          {error ? (
            <div className="mx-auto mb-3 flex max-w-4xl items-center justify-between gap-3 border border-red-400/20 bg-red-400/5 px-3 py-2 text-xs text-red-300">
              <span>{error}</span>
              <Button type="text" size="small" icon={<CloseOutlined />} aria-label="Dismiss error" onClick={() => setError(null)} />
            </div>
          ) : null}
          <div className="mx-auto max-w-4xl">
            {!conversation ? (
              <Select
                className="mb-2 w-full sm:max-w-md"
                aria-label="Select Agent"
                value={selectedAgentId || undefined}
                options={agentOptions}
                placeholder="Select an Agent"
                onChange={setSelectedAgentId}
              />
            ) : null}
            <div className="flex items-end gap-2 border border-white/10 bg-black/30 p-2 focus-within:border-[#b8f500]/35">
              <Input.TextArea
                data-testid="chat-composer"
                autoSize={{ minRows: 1, maxRows: 6 }}
                variant="borderless"
                value={composer}
                disabled={!initialAgents.length || runIsActive}
                placeholder={runIsActive ? "Wait for the active run or stop it…" : "Message the governed Agent…"}
                onChange={(event) => setComposer(event.target.value)}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                onKeyDown={composerKeyDown}
              />
              {runIsActive ? (
                <Button
                  data-testid="cancel-run"
                  danger
                  size="large"
                  icon={<StopOutlined />}
                  loading={cancelRequested}
                  onClick={() => void cancelRun()}
                >
                  Stop
                </Button>
              ) : (
                <Button
                  data-testid="send-message"
                  type="primary"
                  size="large"
                  icon={<SendOutlined />}
                  loading={sending}
                  disabled={!composer.trim() || !selectedAgentId}
                  onClick={() => void sendMessage()}
                >
                  Send
                </Button>
              )}
            </div>
            <p className="mb-0 mt-2 text-center font-mono text-[10px] text-zinc-700">
              ENTER SENDS · SHIFT+ENTER ADDS A LINE · OUTPUT IS MARKDOWN-SANITIZED
            </p>
          </div>
        </footer>
      </section>
    </main>
  );
}
