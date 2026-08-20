import { StatusCard } from "@agentmix/ui";
import { getAuthContext } from "../_lib/auth";

export default async function HomePage() {
  const auth = await getAuthContext();

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <div className="grid gap-8 lg:grid-cols-[1fr_19rem]">
        <section>
          <p className="font-mono text-xs tracking-[0.28em] text-[#b8f500] uppercase">System ready / 01</p>
          <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
            治理 Agent，像治理任何企业核心资源一样。
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-400">
            控制面已建立身份、会话和权限边界。下一阶段将在这套治理内接入模型与对话 Agent。
          </p>

          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatusCard title="server (NestJS)" status="ok" detail=":3101/api/health" />
            <StatusCard title="authorization" status="ok" detail="subject → role → permission" />
            <StatusCard title="agent-worker" status="ok" detail="queue: agent-tasks" />
          </div>
        </section>

        <aside className="border border-white/10 bg-white/[0.025] p-5">
          <p className="font-mono text-[11px] tracking-[0.22em] text-zinc-600 uppercase">Active subject</p>
          <p className="mt-4 text-lg font-medium">{auth?.user.displayName}</p>
          <p className="font-mono text-xs text-zinc-500">{auth?.user.id}</p>
          <div className="my-5 h-px bg-white/10" />
          <p className="text-xs text-zinc-500">角色</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {auth?.roles.map((role) => (
              <span key={role.id} className="border border-[#b8f500]/30 px-2 py-1 font-mono text-xs text-[#caff24]">
                {role.key}
              </span>
            ))}
          </div>
          <p className="mt-5 font-mono text-xs text-zinc-600">
            {auth?.permissions.length ?? 0} effective permissions
          </p>
        </aside>
      </div>
    </main>
  );
}
