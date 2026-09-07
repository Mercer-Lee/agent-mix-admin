import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusCard } from "./status-card";

describe("StatusCard", () => {
  it("renders an explicit unknown state", () => {
    render(<StatusCard title="agent runtime" status="unknown" detail="Worker presence cannot be determined" />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText("Worker presence cannot be determined")).toBeInTheDocument();
    expect(screen.getByText("agent runtime").closest("article")).toHaveAttribute("data-status", "unknown");
  });
});
