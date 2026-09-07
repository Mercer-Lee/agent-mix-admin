import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWorkspace } from "./chat-workspace";
import type { AgentRun, ChatAgent, ConversationDetailResponse, ConversationSummary } from "./types";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  create: vi.fn(),
  send: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, refresh: mocks.refresh }) }));
vi.mock("./actions", () => ({
  createConversationAction: mocks.create,
  sendConversationMessageAction: mocks.send,
  cancelRunAction: mocks.cancel,
  deleteConversationAction: mocks.remove,
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventListenerOrEventListenerObject) {
    const callback = listener as (event: MessageEvent<string>) => void;
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
  }

  close() {
    this.closed = true;
  }

  emit(name: string, data: Record<string, unknown>, id = "1") {
    const event = { data: JSON.stringify(data), lastEventId: id } as MessageEvent<string>;
    this.listeners.get(name)?.forEach((listener) => listener(event));
  }
}

const agent: ChatAgent = {
  id: "019d2f5b-a8ab-7000-8000-000000000001",
  slug: "agentmix-assistant",
  name: "AgentMix Assistant",
  description: "Governed assistant",
};

const conversation: ConversationSummary = {
  id: "019d2f5b-a8ab-7000-8000-000000000002",
  title: "Directory lookup",
  agentId: agent.id,
  agent,
  createdAt: "2026-08-29T03:00:00.000Z",
  updatedAt: "2026-08-29T03:00:00.000Z",
};

const run: AgentRun = {
  id: "019d2f5b-a8ab-7000-8000-000000000003",
  conversationId: conversation.id,
  status: "queued",
  attempt: 1,
  usage: null,
  errorCode: null,
};

const detail: ConversationDetailResponse = {
  conversation,
  messages: [{
    id: "019d2f5b-a8ab-7000-8000-000000000004",
    conversationId: conversation.id,
    role: "user",
    content: "Find Alex",
    createdAt: "2026-08-29T03:00:00.000Z",
  }],
  activeRun: run,
};

describe("ChatWorkspace", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("applies delta, tool status, reset and reconnect events", async () => {
    render(<ChatWorkspace initialAgents={[agent]} initialConversations={[conversation]} initialDetail={detail} />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0]!;

    act(() => source.onopen?.(new Event("open")));
    act(() => source.emit("text.delta", { delta: "Old partial" }, "1"));
    expect(screen.getByText("Old partial")).toBeInTheDocument();

    act(() => source.emit("capability.started", { capabilityRequestId: "cap-1", capabilityId: "users.search" }, "2"));
    expect(screen.getByText("users.search")).toBeInTheDocument();
    expect(screen.getByText("RUNNING")).toBeInTheDocument();

    act(() => source.emit("reset", { attempt: 2 }, "3"));
    expect(screen.queryByText("Old partial")).not.toBeInTheDocument();
    expect(screen.queryByText("users.search")).not.toBeInTheDocument();

    act(() => source.emit("text.delta", { delta: "Fresh answer" }, "4"));
    expect(screen.getByText("Fresh answer")).toBeInTheDocument();

    act(() => source.onerror?.(new Event("error")));
    expect(screen.getByText(/RECONNECTING/)).toBeInTheDocument();
  });

  it("cancels the current queued or active run", async () => {
    mocks.cancel.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<ChatWorkspace initialAgents={[agent]} initialConversations={[conversation]} initialDetail={detail} />);

    await user.click(screen.getByTestId("cancel-run"));
    await waitFor(() => expect(mocks.cancel).toHaveBeenCalledWith(run.id));
  });

  it("clears a pending stop request when a different run becomes active", async () => {
    mocks.cancel.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const { rerender } = render(
      <ChatWorkspace initialAgents={[agent]} initialConversations={[conversation]} initialDetail={detail} />,
    );

    await user.click(screen.getByTestId("cancel-run"));
    await waitFor(() => expect(screen.getByTestId("cancel-run")).toHaveClass("ant-btn-loading"));

    const nextRun: AgentRun = { ...run, id: "019d2f5b-a8ab-7000-8000-000000000009", status: "running" };
    rerender(
      <ChatWorkspace
        initialAgents={[agent]}
        initialConversations={[conversation]}
        initialDetail={{ ...detail, activeRun: nextRun }}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("cancel-run")).not.toHaveClass("ant-btn-loading"));
  });

  it("scrolls the newest streamed content into view", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      render(<ChatWorkspace initialAgents={[agent]} initialConversations={[conversation]} initialDetail={detail} />);
      await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
      const source = FakeEventSource.instances[0]!;
      expect(scrollIntoView).toHaveBeenCalled();

      scrollIntoView.mockClear();
      act(() => source.emit("text.delta", { delta: "Bottom follow" }, "1"));
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" });
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it.each(["canceled", "cancelled"] as const)("renders %s runs as terminal", (status) => {
    render(
      <ChatWorkspace
        initialAgents={[agent]}
        initialConversations={[conversation]}
        initialDetail={{ ...detail, activeRun: { ...run, status } }}
      />,
    );

    expect(screen.getByTestId("run-badge")).toHaveAttribute("data-tone", "default");
  });

  it("reconciles the streamed assistant message with persisted data after refresh", async () => {
    const persistedAssistant = {
      id: "019d2f5b-a8ab-7000-8000-000000000005",
      conversationId: conversation.id,
      role: "assistant" as const,
      content: "Persisted answer",
      createdAt: "2026-08-29T03:01:00.000Z",
      runId: run.id,
    };
    const terminalDetail: ConversationDetailResponse = {
      conversation,
      messages: [...detail.messages, persistedAssistant],
      activeRun: null,
    };
    const { container, rerender } = render(
      <ChatWorkspace initialAgents={[agent]} initialConversations={[conversation]} initialDetail={detail} />,
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => FakeEventSource.instances[0]!.emit("run.completed", { text: "Persisted answer", usage: null }));

    expect(container.querySelector(`[data-message-id="stream-${run.id}"]`)).toBeInTheDocument();
    expect(mocks.refresh).toHaveBeenCalledTimes(1);

    rerender(
      <ChatWorkspace
        initialAgents={[agent]}
        initialConversations={[conversation]}
        initialDetail={terminalDetail}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector(`[data-message-id="stream-${run.id}"]`)).not.toBeInTheDocument();
      expect(container.querySelector(`[data-message-id="${persistedAssistant.id}"]`)).toBeInTheDocument();
      expect(screen.getAllByText("Persisted answer")).toHaveLength(1);
    });
  });

  it("starts a conversation with a UUID idempotency key", async () => {
    mocks.create.mockResolvedValue({ ok: true, data: { conversation, run } });
    const user = userEvent.setup();
    render(<ChatWorkspace initialAgents={[agent]} initialConversations={[]} />);

    await user.type(screen.getByTestId("chat-composer"), "Hello");
    await user.click(screen.getByTestId("send-message"));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    expect(mocks.create).toHaveBeenCalledWith({
      agentId: agent.id,
      content: "Hello",
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(mocks.push).toHaveBeenCalledWith(`/chat/${conversation.id}`);
  });

  it("does not send Enter while an IME composition is active", async () => {
    mocks.create.mockResolvedValue({ ok: true, data: { conversation, run } });
    const user = userEvent.setup();
    render(<ChatWorkspace initialAgents={[agent]} initialConversations={[]} />);
    const composer = screen.getByTestId("chat-composer");

    await user.type(composer, "你好");
    fireEvent.compositionStart(composer);
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
    expect(mocks.create).not.toHaveBeenCalled();

    fireEvent.compositionEnd(composer);
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
  });

  it("keeps the composer in the flex viewport instead of using a fixed header offset", () => {
    const { container } = render(<ChatWorkspace initialAgents={[agent]} initialConversations={[]} />);
    const workspace = container.querySelector("main");
    const footer = container.querySelector("footer");

    expect(workspace).toHaveClass("flex-1", "min-h-0");
    expect(workspace?.className).not.toContain("100vh");
    expect(footer).toHaveClass("shrink-0");
    expect(screen.getByTestId("chat-composer")).toBeVisible();
  });
});
