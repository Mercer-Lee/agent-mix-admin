import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelsManager } from "./models-manager";
import type { ModelProfile } from "./types";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  check: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("./actions", () => ({
  createModelAction: mocks.create,
  updateModelAction: mocks.update,
  checkModelAction: mocks.check,
}));

const model: ModelProfile = {
  id: "019d2f5b-a8ab-7000-8000-000000000010",
  key: "default",
  name: "Default",
  description: "Default runtime profile",
  provider: "openai-compatible",
  connection: "default",
  modelId: "test-model",
  status: "active",
  lastCheck: null,
};

describe("ModelsManager", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("never renders credential or base URL form controls", async () => {
    const user = userEvent.setup();
    render(
      <ModelsManager
        initialData={{ items: [model] }}
        access={{ canCreate: true, canUpdate: true, canTest: true }}
      />,
    );

    await user.click(screen.getByTestId("create-model"));
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/base url/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/authorization/i)).not.toBeInTheDocument();
  });

  it("submits only public profile fields", async () => {
    mocks.create.mockResolvedValue({ ok: true, data: { ...model, id: "new-model", key: "reasoning" } });
    const user = userEvent.setup();
    render(
      <ModelsManager
        initialData={{ items: [model] }}
        access={{ canCreate: true, canUpdate: true, canTest: true }}
      />,
    );

    await user.click(screen.getByTestId("create-model"));
    await user.type(screen.getByTestId("model-key"), "reasoning");
    await user.type(screen.getByTestId("model-name"), "Reasoning");
    await user.type(screen.getByTestId("model-id"), "reasoner-v1");
    await user.click(screen.getByTestId("submit-model"));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(1));
    const payload = mocks.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload).toEqual({
      key: "reasoning",
      name: "Reasoning",
      modelId: "reasoner-v1",
      description: "",
    });
    expect(payload).not.toHaveProperty("apiKey");
    expect(payload).not.toHaveProperty("baseUrl");
    expect(payload).not.toHaveProperty("connection");
  });

  it("shows the asynchronous check result without provider error details", async () => {
    mocks.check.mockResolvedValue({
      ok: true,
      data: {
        id: "019d2f5b-a8ab-7000-8000-000000000020",
        status: "succeeded",
        latencyMs: 84,
        errorCode: null,
        completedAt: "2026-08-29T04:00:00.000Z",
      },
    });
    const user = userEvent.setup();
    render(
      <ModelsManager
        initialData={{ items: [model] }}
        access={{ canCreate: true, canUpdate: true, canTest: true }}
      />,
    );

    await user.click(screen.getByTestId(`check-model-${model.id}`));
    expect(await screen.findByText("HEALTHY")).toBeInTheDocument();
    expect(screen.getByText("84ms")).toBeInTheDocument();
  });

  it("preserves the latest check when a profile save response omits it", async () => {
    const lastCheck = {
      id: "019d2f5b-a8ab-7000-8000-000000000021",
      status: "succeeded" as const,
      latencyMs: 62,
      errorCode: null,
      completedAt: "2026-08-29T04:00:00.000Z",
    };
    mocks.update.mockResolvedValue({
      ok: true,
      data: { ...model, name: "Updated Default", lastCheck: null },
    });
    const user = userEvent.setup();
    render(
      <ModelsManager
        initialData={{ items: [{ ...model, lastCheck }] }}
        access={{ canCreate: true, canUpdate: true, canTest: true }}
      />,
    );

    await user.click(screen.getByTestId(`edit-model-${model.id}`));
    await user.clear(screen.getByTestId("model-name"));
    await user.type(screen.getByTestId("model-name"), "Updated Default");
    await user.click(screen.getByTestId("submit-model"));

    expect(await screen.findByText("Updated Default")).toBeInTheDocument();
    expect(screen.getByText("HEALTHY")).toBeInTheDocument();
    expect(screen.getByText("62ms")).toBeInTheDocument();
  });
});
