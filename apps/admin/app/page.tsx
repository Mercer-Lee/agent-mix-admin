import { StatusCard } from "@agentmix/ui";

export default function HomePage() {
  return (
    <main className="mx-auto max-w-4xl p-8">
      <p className="text-sm font-medium tracking-widest text-zinc-500 uppercase">AgentMix</p>
      <h1 className="mt-2 text-3xl font-bold">Admin 控制台</h1>
      <p className="mt-2 text-zinc-400">骨架已就绪 —— 这里将长出 Agent 管理、模型网关、成本中心与审计。</p>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatusCard title="server (NestJS)" status="ok" detail=":3101/api/health" />
        <StatusCard title="agent-worker (BullMQ)" status="ok" detail="queue: agent-tasks" />
        <StatusCard title="postgres / redis" status="warn" detail="docker compose up -d" />
      </div>
    </main>
  );
}
