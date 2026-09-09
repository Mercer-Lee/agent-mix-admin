"use client";

import { useTranslations } from "next-intl";

export type HealthStatus = "ok" | "warn" | "down" | "unknown";

const STATUS_META: Record<HealthStatus, { className: string; dot: string }> = {
  ok: {
    className: "border-[#b8f500]/20 bg-[#b8f500]/5 text-[#caff24]",
    dot: "bg-[#b8f500]",
  },
  warn: {
    className: "border-amber-400/25 bg-amber-400/5 text-amber-300",
    dot: "bg-amber-300",
  },
  down: {
    className: "border-red-400/25 bg-red-400/5 text-red-300",
    dot: "bg-red-400",
  },
  unknown: {
    className: "border-white/10 bg-white/[0.025] text-zinc-400",
    dot: "bg-zinc-600",
  },
};

export function StatusCard({
  title,
  status,
  detail,
}: {
  title: string;
  status: HealthStatus;
  detail?: string;
}) {
  const t = useTranslations("statusCard.status");
  const meta = STATUS_META[status];
  return (
    <article data-status={status} className={`border p-4 ${meta.className}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-sm font-medium text-zinc-200">{title}</h2>
        <span className="inline-flex items-center gap-2 font-mono text-[10px] tracking-[0.15em] uppercase">
          <span className={`h-1.5 w-1.5 ${meta.dot}`} aria-hidden="true" />
          {t(status)}
        </span>
      </div>
      {detail ? <p className="mb-0 mt-4 font-mono text-xs text-zinc-500">{detail}</p> : null}
    </article>
  );
}
