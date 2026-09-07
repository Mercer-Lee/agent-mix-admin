import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthContext } from "../_lib/auth";
import { LogoutButton } from "./logout-button";

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");

  const navigation = [
    { href: "/", label: "Overview", visible: true },
    { href: "/models", label: "Models", visible: auth.permissions.includes("models:read") },
    { href: "/agents", label: "Agents", visible: auth.permissions.includes("agents:read") },
    { href: "/chat", label: "Workbench", visible: auth.permissions.includes("agents:invoke") },
    {
      href: "/audit",
      label: "Audit",
      visible:
        auth.permissions.includes("audit-logs:read") ||
        auth.permissions.includes("conversations:audit"),
    },
  ].filter((item) => item.visible);

  return (
    <div className="flex min-h-dvh flex-col bg-[#0a0c0d] text-zinc-100">
      <header className="sticky top-0 z-40 shrink-0 border-b border-white/10 bg-[#0d1011]/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-4">
            <div className="grid h-9 w-9 place-items-center border border-[#b8f500]/50 bg-[#b8f500]/10 font-mono text-xs font-bold text-[#caff24]">
              AM
            </div>
            <div>
              <p className="m-0 text-xs tracking-[0.24em] text-zinc-500 uppercase">Control Plane</p>
              <p className="m-0 text-sm font-semibold text-zinc-100">AgentMix Admin</p>
            </div>
            <nav
              className="ml-3 hidden items-center gap-1 border-l border-white/10 pl-5 md:flex"
              aria-label="Main navigation"
            >
              {navigation.map((item) => (
                <Link
                  key={item.href}
                  className="px-3 py-2 text-sm text-zinc-400 no-underline hover:text-[#caff24]"
                  href={item.href}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden text-right sm:block">
              <p className="m-0 text-sm text-zinc-200">{auth.user.displayName}</p>
              <p className="m-0 font-mono text-xs text-zinc-600">@{auth.user.username}</p>
            </div>
            <LogoutButton />
          </div>
        </div>
        <nav
          className="mx-auto flex max-w-7xl gap-1 overflow-x-auto border-t border-white/5 px-4 py-2 md:hidden"
          aria-label="Mobile navigation"
        >
          {navigation.map((item) => (
            <Link
              key={item.href}
              className="shrink-0 px-3 py-1.5 font-mono text-xs tracking-wide text-zinc-400 no-underline hover:text-[#caff24]"
              href={item.href}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
    </div>
  );
}
