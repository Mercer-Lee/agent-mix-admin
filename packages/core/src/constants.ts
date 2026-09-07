/** Control plane -> Runtime. Carries versioned Agent runs and model checks. */
export const AGENT_RUN_TASKS_QUEUE = "agent-run-tasks-v1";

/** Runtime -> control plane. Carries durable, idempotent stream events. */
export const AGENT_RUN_EVENTS_QUEUE = "agent-run-events-v1";

/** Runtime -> control plane Capability executor. The BullMQ return value is the response. */
export const AGENT_CAPABILITY_REQUESTS_QUEUE = "agent-capability-requests-v1";

/** Redis pub/sub channel used to abort active runs. */
export const AGENT_RUN_CONTROL_CHANNEL = "agent-run-control-v1";

/** Persistent control-plane outbox topic used to deliver cancellation commands. */
export const AGENT_RUN_CANCEL_OUTBOX_TOPIC = "agent.run.cancel.requested";

/** Prefix for cancellation markers checked before a queued run starts. */
export const AGENT_RUN_CANCELLED_KEY_PREFIX = "agent-run-cancelled-v1:";

/** Short-lived marker used to detect a BullMQ stalled-job replay. */
export const AGENT_RUN_EXECUTION_KEY_PREFIX = "agent-run-execution-v1:";

/**
 * @deprecated Phase 1C uses {@link AGENT_RUN_TASKS_QUEUE}. The legacy value is
 * intentionally isolated so an old payload cannot enter the V1 Runtime queue.
 */
export const AGENT_TASKS_QUEUE = "agent-tasks";
