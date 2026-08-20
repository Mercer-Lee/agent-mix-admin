import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getAuthContext } from "../_lib/auth";
import { LogoutButton } from "./logout-button";

export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const auth = await getAuthContext();
  if (!auth) redirect("/login");

  return (
    <div className="min-h-screen bg-[#0a0c0d] text-zinc-100">
      <header className="border-b border-white/10 bg-[#0d1011]/95">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <div className="grid h-9 w-9 place-items-center border border-[#b8f500]/50 bg-[#b8f500]/10 font-mono text-xs font-bold text-[#caff24]">
              AM
            </div>
            <div>
              <p className="m-0 text-xs tracking-[0.24em] text-zinc-500 uppercase">Control Plane</p>
              <p className="m-0 text-sm font-semibold text-zinc-100">AgentMix Admin</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden text-right sm:block">
              <p className="m-0 text-sm text-zinc-200">{auth.user.displayName}</p>
              <p className="m-0 font-mono text-xs text-zinc-600">@{auth.user.username}</p>
            </div>
            <LogoutButton />
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}
