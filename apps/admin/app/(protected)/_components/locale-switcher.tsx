"use client";

import { GlobalOutlined } from "@ant-design/icons";
import { Select } from "antd";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { LOCALE_COOKIE, locales } from "../../../i18n/config";

const LOCALE_LABELS: Record<(typeof locales)[number], string> = {
  en: "English",
  "zh-CN": "简体中文",
};

export function LocaleSwitcher() {
  const t = useTranslations("app");
  const locale = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function change(next: string) {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    startTransition(() => router.refresh());
  }

  return (
    <Select
      aria-label={t("language")}
      prefix={<GlobalOutlined />}
      loading={pending}
      onChange={change}
      options={locales.map((value) => ({ value, label: LOCALE_LABELS[value] }))}
      size="small"
      style={{ minWidth: 116 }}
      value={locale}
    />
  );
}
