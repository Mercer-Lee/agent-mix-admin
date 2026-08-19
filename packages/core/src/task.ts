import { z } from "zod";

/** 控制面投递到执行面的任务载荷 */
export const AgentTaskSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  input: z.string(),
});

export const AgentTaskResultSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(["completed", "failed"]),
  output: z.string().optional(),
  error: z.string().optional(),
});

export type AgentTask = z.infer<typeof AgentTaskSchema>;
export type AgentTaskResult = z.infer<typeof AgentTaskResultSchema>;
