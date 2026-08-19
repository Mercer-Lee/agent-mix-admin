import { z } from "zod";

/** Task payload dispatched from the control plane to the execution plane. */
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
