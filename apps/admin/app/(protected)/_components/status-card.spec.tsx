import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import commonMessages from "../../../messages/en/common.json";
import { StatusCard } from "./status-card";

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ statusCard: commonMessages.statusCard }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("StatusCard", () => {
  it("renders an explicit unknown state", () => {
    renderWithIntl(
      <StatusCard title="agent runtime" status="unknown" detail="Worker presence cannot be determined" />,
    );
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText("Worker presence cannot be determined")).toBeInTheDocument();
    expect(screen.getByText("agent runtime").closest("article")).toHaveAttribute("data-status", "unknown");
  });
});
