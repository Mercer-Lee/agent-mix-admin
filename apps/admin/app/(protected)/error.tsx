"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Button, Result } from "antd";

interface ProtectedErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ProtectedError({ error, reset }: ProtectedErrorProps) {
  return (
    <main className="agentmix-grid flex min-h-[calc(100vh-74px)] items-center justify-center px-4">
      <Result
        status="error"
        title="This page could not be loaded"
        subTitle={
          error.digest
            ? `The request failed and was stopped. Reference: ${error.digest}`
            : "The control plane rejected or failed the request. Retry, or navigate back to a reachable page."
        }
        extra={
          <Button type="primary" icon={<ReloadOutlined />} onClick={() => reset()}>
            Try again
          </Button>
        }
      />
    </main>
  );
}
