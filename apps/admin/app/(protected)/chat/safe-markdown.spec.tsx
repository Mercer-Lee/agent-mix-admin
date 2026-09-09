import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SafeMarkdown } from "./safe-markdown";

describe("SafeMarkdown", () => {
  afterEach(cleanup);

  it("renders markdown without interpreting raw HTML", () => {
    const { container } = render(
      <SafeMarkdown content={'**Safe** <script>alert("secret")</script> [bad](javascript:alert(1))'} />,
    );

    expect(screen.getByText("Safe")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.getByText(/<script>alert/)).toBeInTheDocument();
  });
});
