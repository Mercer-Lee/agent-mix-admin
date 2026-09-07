import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditConsole } from "./audit-console";
import type { AuditEvent, ConversationAuditSummary, PaginatedResponse } from "./types";

const event: AuditEvent = {
  id: "019d2f5b-a8ab-7000-8000-000000000001",
  action: "agent.runtime.updated",
  resourceType: "agent",
  resourceId: "019d2f5b-a8ab-7000-8000-000000000002",
  outcome: "success",
  actorSubjectId: "019d2f5b-a8ab-7000-8000-000000000003",
  metadata: { status: "active", prompt: "SECRET_SENTINEL" },
  createdAt: "2026-08-29T03:00:00.000Z",
};

const conversation: ConversationAuditSummary = {
  id: "019d2f5b-a8ab-7000-8000-000000000004",
  actor: { id: "user-1", username: "admin", displayName: "Admin" },
  agent: { id: "agent-1", name: "Assistant" },
  model: { key: "default", modelId: "test-model" },
  status: "completed",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  createdAt: "2026-08-29T03:00:00.000Z",
  updatedAt: "2026-08-29T03:01:00.000Z",
};

const events: PaginatedResponse<AuditEvent> = { items: [event], total: 1, page: 1, pageSize: 50 };
const conversations: PaginatedResponse<ConversationAuditSummary> = { items: [conversation], total: 1, page: 1, pageSize: 50 };

const mocks = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));

describe("AuditConsole", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("redacts content-like keys from ordinary audit metadata", () => {
    render(<AuditConsole events={events} conversations={null} canReadContent={false} />);
    expect(screen.getByText(/"status":"active"/)).toBeInTheDocument();
    expect(screen.queryByText(/SECRET_SENTINEL/)).not.toBeInTheDocument();
  });

  it("does not request message bodies without conversations:read-content", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(conversation), { status: 200 }),
    );
    const user = userEvent.setup();
    render(<AuditConsole events={null} conversations={conversations} canReadContent={false} />);

    await user.click(screen.getByTestId(`audit-conversation-${conversation.id}`));
    expect(await screen.findByText("Message bodies are protected")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`/api/audit/conversations/${conversation.id}`);
    expect(screen.getByText("Conversation record")).toBeInTheDocument();
  });

  it("requests and renders retained content only with the explicit permission", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path.endsWith("/messages")) {
        return new Response(JSON.stringify({ items: [{
          id: "message-1",
          conversationId: conversation.id,
          role: "assistant",
          content: "Audited answer",
          createdAt: "2026-08-29T03:01:00.000Z",
        }] }), { status: 200 });
      }
      return new Response(JSON.stringify(conversation), { status: 200 });
    });
    const user = userEvent.setup();
    render(<AuditConsole events={null} conversations={conversations} canReadContent />);

    await user.click(screen.getByTestId(`audit-conversation-${conversation.id}`));
    await waitFor(() => expect(screen.getByText("Audited answer")).toBeInTheDocument());
  });

  it("ignores a stale conversation detail response that resolves after a newer inspect request", async () => {
    const conversationA: ConversationAuditSummary = {
      ...conversation,
      id: "019d2f5b-a8ab-7000-8000-000000000010",
      model: { key: "profile-a", modelId: "model-a" },
    };
    const conversationB: ConversationAuditSummary = {
      ...conversation,
      id: "019d2f5b-a8ab-7000-8000-000000000011",
      model: { key: "profile-b", modelId: "model-b" },
    };
    let releaseA: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input);
      if (path.includes(conversationA.id)) {
        return new Promise<Response>((resolve) => {
          releaseA = resolve;
        });
      }
      return new Response(JSON.stringify(conversationB), { status: 200 });
    });
    const user = userEvent.setup();
    render(
      <AuditConsole
        events={null}
        conversations={{ items: [conversationA, conversationB], total: 2, page: 1, pageSize: 50 }}
        canReadContent={false}
      />,
    );

    await user.click(screen.getByTestId(`audit-conversation-${conversationA.id}`));
    await user.click(screen.getByTestId(`audit-conversation-${conversationB.id}`));
    await waitFor(() => expect(screen.getAllByText("model-b")).toHaveLength(2));

    await act(async () => {
      releaseA!(new Response(JSON.stringify(conversationA), { status: 200 }));
    });

    expect(screen.getAllByText("model-b")).toHaveLength(2);
    expect(screen.getAllByText("model-a")).toHaveLength(1);
    expect(screen.queryByText("Unable to load the selected conversation audit record.")).not.toBeInTheDocument();
  });

  it("keeps both server-rendered audit cursors reachable through URL pagination", async () => {
    const user = userEvent.setup();
    render(
      <AuditConsole
        events={{ ...events, page: 2, total: 101 }}
        conversations={{ ...conversations, total: 101 }}
        canReadContent={false}
      />,
    );

    await user.click(screen.getByRole("tab", { name: /Conversation audit/i }));
    const conversationSection = screen.getByTestId("audit-conversations-section");
    await user.click(conversationSection.querySelector('[title="2"]') as HTMLElement);

    expect(mocks.push).toHaveBeenCalledWith("/audit?eventsPage=2&conversationsPage=2");
  });
});
