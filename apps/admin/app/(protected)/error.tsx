"use client";

import { ReloadOutlined } from "@ant-design/icons";
import { Button, Result } from "antd";
import { useTranslations } from "next-intl";

interface ProtectedErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ProtectedError({ error, reset }: ProtectedErrorProps) {
  const t = useTranslations("errors");

  return (
    <main className="agentmix-grid flex min-h-[calc(100dvh-3.5rem)] items-center justify-center px-4">
      <Result
        status="error"
        title={t("title")}
        subTitle={error.digest ? t("subTitleWithDigest", { digest: error.digest }) : t("subTitle")}
        extra={
          <Button type="primary" icon={<ReloadOutlined />} onClick={() => reset()}>
            {t("tryAgain")}
          </Button>
        }
      />
    </main>
  );
}
