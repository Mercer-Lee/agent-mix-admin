import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "./login-form";

const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

describe("LoginForm", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    replace.mockReset();
    refresh.mockReset();
  });

  it("submits credentials and enters the console", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const user = userEvent.setup();
    render(<LoginForm />);

    await user.type(screen.getByLabelText("用户名"), "admin");
    await user.type(screen.getByLabelText("密码"), "correct-horse-battery-staple");
    await user.click(screen.getByRole("button", { name: "验证身份并进入" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/login",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(replace).toHaveBeenCalledWith("/");
    expect(refresh).toHaveBeenCalled();
  });

  it("shows one generic error for rejected credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    render(<LoginForm />);

    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "admin" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "incorrect-password" } });
    fireEvent.click(screen.getByRole("button", { name: "验证身份并进入" }));

    expect(await screen.findByText("用户名或密码不正确。请输入后重试。")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
