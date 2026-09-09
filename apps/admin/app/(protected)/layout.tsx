import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getAuthContext } from "../_lib/auth";
import { AppShell, type AppNavItem } from "./_components/app-shell";

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");

  const candidates: Array<AppNavItem & { visible: boolean }> = [
    { key: "overview", href: "/", visible: true },
    { key: "models", href: "/models", visible: auth.permissions.includes("models:read") },
    { key: "agents", href: "/agents", visible: auth.permissions.includes("agents:read") },
    { key: "workbench", href: "/chat", visible: auth.permissions.includes("agents:invoke") },
    {
      key: "audit",
      href: "/audit",
      visible:
        auth.permissions.includes("audit-logs:read") ||
        auth.permissions.includes("conversations:audit"),
    },
  ];

  return (
    <AppShell
      displayName={auth.user.displayName}
      navItems={candidates.filter((item) => item.visible)}
      username={auth.user.username}
    >
      {children}
    </AppShell>
  );
}
