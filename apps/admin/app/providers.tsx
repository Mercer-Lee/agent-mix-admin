"use client";

import type { ReactNode } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import enUS from "antd/locale/en_US";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider
      locale={enUS}
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
          Table: { headerBg: "#0d1011", rowHoverBg: "rgba(184, 245, 0, 0.04)" },
          Tabs: { inkBarColor: "#b8f500", itemSelectedColor: "#caff24" },
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
}
