"use client";

import type { ReactNode } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";
import enUS from "antd/locale/en_US";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider locale={enUS} theme={{ algorithm: antdTheme.darkAlgorithm }}>
      {children}
    </ConfigProvider>
  );
}
