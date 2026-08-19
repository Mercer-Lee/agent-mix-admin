import IORedis from "ioredis";
import { Worker } from "bullmq";
import { AGENT_TASKS_QUEUE, type AgentTask } from "@agentmix/core";

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
connection.on("error", (err) => console.error("[worker] redis error:", err.message));

const worker = new Worker<AgentTask>(
  AGENT_TASKS_QUEUE,
  // Placeholder executor: the real agent runtime (Vercel AI SDK adapter + MCP tools) plugs in here in Phase 2
  async (job) => {
    const { taskId, agentId, input } = job.data;
    console.log(`[worker] processing task ${taskId} for agent ${agentId}`);
    return { taskId, status: "completed" as const, output: `echo: ${input}` };
  },
  { connection, concurrency: 5 },
);

worker.on("completed", (job) => console.log(`[worker] task ${job.data.taskId} completed`));
worker.on("failed", (job, err) =>
  console.error(`[worker] task ${job?.data.taskId ?? job?.id ?? "unknown"} failed:`, err.message),
);

console.log(`[worker] listening on queue "${AGENT_TASKS_QUEUE}" (${redisUrl})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await worker.close();
    connection.disconnect();
    process.exit(0);
  });
}
