import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import commonMessages from "../../messages/en/common.json";
import { LoginForm } from "./login-form";

const replace = vi.fn();
const refresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh }),
}));

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ login: commonMessages.login }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

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
    renderWithIntl(<LoginForm />);

    await user.type(screen.getByTestId("login-username"), "admin");
    await user.type(screen.getByTestId("login-password"), "correct-horse-battery-staple");
    await user.click(screen.getByTestId("login-submit"));

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
    renderWithIntl(<LoginForm />);

    fireEvent.change(screen.getByTestId("login-username"), { target: { value: "admin" } });
    fireEvent.change(screen.getByTestId("login-password"), { target: { value: "incorrect-password" } });
    fireEvent.click(screen.getByTestId("login-submit"));

    expect(await screen.findByTestId("login-error")).toBeVisible();
    expect(replace).not.toHaveBeenCalled();
  });
});
