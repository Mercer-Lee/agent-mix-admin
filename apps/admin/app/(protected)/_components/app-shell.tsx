"use client";

import {
  DashboardOutlined,
  DatabaseOutlined,
  FileSearchOutlined,
  MenuFoldOutlined,
  MenuOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  RobotOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import { Button, Drawer, Grid, Layout, Menu } from "antd";
import type { MenuProps } from "antd";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import { LocaleSwitcher } from "./locale-switcher";
import { LogoutButton } from "../logout-button";

export type AppNavKey = "overview" | "models" | "tools" | "agents" | "workbench" | "audit";

export interface AppNavItem {
  key: AppNavKey;
  href: string;
}

interface AppShellProps {
  displayName: string;
  username: string;
  navItems: AppNavItem[];
  children: ReactNode;
}

const NAV_ICONS: Record<AppNavKey, ComponentType> = {
  overview: DashboardOutlined,
  models: DatabaseOutlined,
  tools: ToolOutlined,
  agents: RobotOutlined,
  workbench: MessageOutlined,
  audit: FileSearchOutlined,
};

const { Sider } = Layout;

function Brand({ showText }: { showText: boolean }) {
  const t = useTranslations("app.brand");
  return (
    <div
      className={`flex h-14 shrink-0 items-center gap-3 border-b border-white/10 ${
        showText ? "px-4" : "justify-center px-0"
      }`}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center border border-[#b8f500]/50 bg-[#b8f500]/10 font-mono text-xs font-bold text-[#caff24]">
        AM
      </span>
      {showText && (
        <span className="min-w-0">
          <span className="block truncate font-mono text-xs tracking-[0.24em] text-zinc-500 uppercase">
            {t("eyebrow")}
          </span>
          <span className="block truncate text-sm font-semibold text-zinc-100">{t("name")}</span>
        </span>
      )}
    </div>
  );
}

function NavMenu({
  items,
  selectedKey,
  label,
  onNavigate,
}: {
  items: MenuProps["items"];
  selectedKey?: string;
  label: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label={label}>
      <Menu
        className="bg-transparent"
        items={items}
        mode="inline"
        selectedKeys={selectedKey ? [selectedKey] : []}
        onClick={onNavigate}
        style={{ borderInlineEnd: 0 }}
      />
    </nav>
  );
}

export function AppShell({ displayName, username, navItems, children }: AppShellProps) {
  const t = useTranslations("app");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const screens = Grid.useBreakpoint();
  const isMobile = screens.lg === false;
  const pathname = usePathname() ?? "/";

  const selectedKey = useMemo(
    () =>
      navItems.find((item) =>
        item.href === "/"
          ? pathname === "/"
          : pathname === item.href || pathname.startsWith(`${item.href}/`),
      )?.key,
    [navItems, pathname],
  );

  const menuItems: MenuProps["items"] = navItems.map((item) => {
    const Icon = NAV_ICONS[item.key];
    return {
      key: item.key,
      icon: <Icon />,
      label: (
        <Link className="text-inherit no-underline" href={item.href}>
          {t(`nav.${item.key}`)}
        </Link>
      ),
    };
  });

  const triggerLabel = isMobile
    ? t("trigger.open")
    : collapsed
      ? t("trigger.expand")
      : t("trigger.collapse");

  return (
    <Layout className="min-h-dvh" hasSider>
      {!isMobile && (
        <Sider
          className="sticky top-0 h-dvh overflow-x-hidden overflow-y-auto border-r border-white/10"
          collapsed={collapsed}
          collapsedWidth={64}
          collapsible
          trigger={null}
          width={224}
        >
          <Brand showText={!collapsed} />
          <NavMenu items={menuItems} selectedKey={selectedKey} label={t("navAria")} />
        </Sider>
      )}
      <Layout className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-[#0d1011]/95 px-4 backdrop-blur-xl">
          <Button
            aria-label={triggerLabel}
            icon={isMobile ? <MenuOutlined /> : collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            type="text"
            onClick={() => (isMobile ? setMobileOpen(true) : setCollapsed((value) => !value))}
          />
          <div className="flex items-center gap-4">
            <LocaleSwitcher />
            <div className="hidden text-right sm:block">
              <p className="m-0 text-sm text-zinc-200">{displayName}</p>
              <p className="m-0 font-mono text-xs text-zinc-600">@{username}</p>
            </div>
            <LogoutButton />
          </div>
        </header>
        {/* 页面组件自带 <main> 根元素，这里用 div 避免 main 嵌套 */}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </Layout>
      <Drawer
        placement="left"
        styles={{ body: { padding: 0 } }}
        width={288}
        onClose={() => setMobileOpen(false)}
        open={mobileOpen}
      >
        <Brand showText />
        <NavMenu
          items={menuItems}
          selectedKey={selectedKey}
          label={t("navAria")}
          onNavigate={() => setMobileOpen(false)}
        />
      </Drawer>
    </Layout>
  );
}
