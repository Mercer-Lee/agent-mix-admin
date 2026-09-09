// 等待控制面 Server（默认 :3101）可访问后再启动 Next dev。
// turbo 并行拉起各包时，admin 常先于 server 就绪，窗口期内 getAuthContext 的
// fetch 会 ECONNREFUSED 使 /login 等页面 500；这里以 /api/health 探活消除该竞态。
const baseUrl = process.env.SERVER_INTERNAL_URL ?? "http://localhost:3101";
const healthUrl = `${baseUrl}/api/health`;
const timeoutMs = Number(process.env.WAIT_SERVER_TIMEOUT_MS) || 90_000;
const intervalMs = 500;

const startedAt = Date.now();

async function isListening() {
  try {
    // 收到任何 HTTP 响应即视为已监听；响应体状态由调用方自行处理。
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_500) });
    return response.status > 0;
  } catch {
    return false;
  }
}

process.stdout.write(`[admin] waiting for control plane at ${healthUrl}\n`);

while (!(await isListening())) {
  if (Date.now() - startedAt > timeoutMs) {
    process.stdout.write(
      `[admin] control plane not ready after ${Math.round(timeoutMs / 1000)}s, starting anyway\n`,
    );
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}

const seconds = Math.round(((Date.now() - startedAt) / 1000) * 10) / 10;
process.stdout.write(`[admin] control plane ready in ${seconds}s\n`);
