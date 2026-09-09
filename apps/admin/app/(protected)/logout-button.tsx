"use client";

import { LogoutOutlined } from "@ant-design/icons";
import { Button } from "antd";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const t = useTranslations("app");
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function logout() {
    setLoading(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } finally {
      router.replace("/login");
      router.refresh();
    }
  }

  return (
    <Button aria-label={t("signOut")} icon={<LogoutOutlined />} loading={loading} onClick={logout}>
      {t("signOut")}
    </Button>
  );
}
