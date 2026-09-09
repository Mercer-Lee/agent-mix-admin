import { startWorker } from "./bullmq-runtime";
import { loadWorkerConfig, loadWorkerEnvironment } from "./config";

const runningWorker = await startWorker(loadWorkerConfig(loadWorkerEnvironment()));

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    void runningWorker.close().finally(() => process.exit(0));
  });
}
