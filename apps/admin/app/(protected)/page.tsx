import { getTranslations } from "next-intl/server";
import { getAuthContext } from "../_lib/auth";
import { StatusCard, type HealthStatus } from "./_components/status-card";

interface HealthResponse {
  status?: "ok" | "warn" | "down";
  service?: string;
  database?: "ok" | "down" | { status?: "ok" | "down" };
  redis?: "ok" | "down" | { status?: "ok" | "down" };
  worker?: { status?: "ok" | "warn" | "unknown"; count?: number | null };
  uptime?: number;
}

function dependencyStatus(value: HealthResponse["database"]): HealthStatus {
  const status = typeof value === "string" ? value : value?.status;
  if (status === "ok" || status === "down") return status;
  return "unknown";
}

async function getHealth(): Promise<HealthResponse | null> {
  try {
    const response = await fetch(
      `${process.env.SERVER_INTERNAL_URL ?? "http://localhost:3101"}/api/health`,
      { cache: "no-store", headers: { accept: "application/json" } },
    );
    const health = (await response.json()) as HealthResponse;
    return health?.status ? health : null;
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const [auth, health, t] = await Promise.all([
    getAuthContext(),
    getHealth(),
    getTranslations("overview"),
  ]);
  const workerCount = health?.worker?.count;
  const workerStatus: HealthStatus =
    !health?.worker || health.worker.status === "unknown" || workerCount === null || workerCount === undefined
      ? "unknown"
      : workerCount === 0 || health.worker.status === "warn"
        ? "warn"
        : health.worker.status === "ok"
          ? "ok"
          : "unknown";

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <div className="grid gap-8 lg:grid-cols-[1fr_19rem]">
        <section>
          <p className="font-mono text-xs tracking-[0.28em] text-[#b8f500] uppercase">{t("eyebrow")}</p>
          <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-[-0.04em] sm:text-5xl">
            {t("headline")}
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-zinc-400">{t("intro")}</p>

          <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatusCard
              title={t("postgresTitle")}
              status={health ? dependencyStatus(health.database) : "unknown"}
              detail={health ? t("postgresDetail") : t("healthUnavailable")}
            />
            <StatusCard
              title={t("redisTitle")}
              status={health ? dependencyStatus(health.redis) : "unknown"}
              detail={t("redisDetail")}
            />
            <StatusCard
              title={t("runtimeTitle")}
              status={workerStatus}
              detail={
                typeof workerCount === "number"
                  ? t("workerCount", { count: workerCount })
                  : t("workerUnknown")
              }
            />
          </div>
        </section>

        <aside className="border border-white/10 bg-white/[0.025] p-5">
          <p className="font-mono text-[11px] tracking-[0.22em] text-zinc-600 uppercase">{t("activeSubject")}</p>
          <p className="mt-4 text-lg font-medium">{auth?.user.displayName}</p>
          <p className="font-mono text-xs text-zinc-500">{auth?.user.id}</p>
          <div className="my-5 h-px bg-white/10" />
          <p className="text-xs text-zinc-500">{t("roles")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {auth?.roles.map((role) => (
              <span key={role.id} className="border border-[#b8f500]/30 px-2 py-1 font-mono text-xs text-[#caff24]">
                {role.key}
              </span>
            ))}
          </div>
          <p className="mt-5 font-mono text-xs text-zinc-600">
            {t("effectivePermissions", { count: auth?.permissions.length ?? 0 })}
          </p>
        </aside>
      </div>
    </main>
  );
}
