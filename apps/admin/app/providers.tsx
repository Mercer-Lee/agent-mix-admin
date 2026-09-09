"use client";

import type { ReactNode } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import enUS from "antd/locale/en_US";
import zhCN from "antd/locale/zh_CN";
import { useLocale } from "next-intl";
import type { AppLocale } from "../i18n/config";

const ANTD_LOCALES: Record<AppLocale, typeof enUS> = {
  en: enUS,
  "zh-CN": zhCN,
};

export function Providers({ children }: { children: ReactNode }) {
  const locale = useLocale();
  const antdLocale = ANTD_LOCALES[locale as AppLocale] ?? enUS;

  return (
    <ConfigProvider
      locale={antdLocale}
      theme={{
        algorithm: antdTheme.darkAlgorithm,
        token: {
          borderRadius: 0,
          colorBgBase: "#0a0c0d",
          colorBgContainer: "#111415",
          colorBorder: "rgba(255, 255, 255, 0.12)",
          colorPrimary: "#b8f500",
          colorPrimaryHover: "#caff24",
          colorText: "#f4f4f5",
          colorTextSecondary: "#a1a1aa",
          fontFamily: '"Avenir Next", "IBM Plex Sans", sans-serif',
          fontFamilyCode: '"JetBrains Mono", "SFMono-Regular", Consolas, monospace',
        },
        components: {
          Button: { primaryColor: "#101300" },
          Layout: { bodyBg: "#0a0c0d", headerBg: "#0d1011", siderBg: "#0d1011" },
          Menu: {
            activeBarBorderWidth: 0,
            itemBg: "transparent",
            itemColor: "#a1a1aa",
            itemHoverBg: "rgba(184, 245, 0, 0.06)",
            itemHoverColor: "#caff24",
            itemMarginInline: 8,
            itemSelectedBg: "rgba(184, 245, 0, 0.12)",
            itemSelectedColor: "#caff24",
            popupBg: "#111415",
          },
          Table: { headerBg: "#0d1011", rowHoverBg: "rgba(184, 245, 0, 0.04)" },
          Tabs: { inkBarColor: "#b8f500", itemSelectedColor: "#caff24" },
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
}
