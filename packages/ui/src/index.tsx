"use client";

import { Card, Tag } from "antd";

type Status = "ok" | "warn" | "down";

const statusMeta: Record<Status, { color: string; text: string }> = {
  ok: { color: "success", text: "Operational" },
  warn: { color: "warning", text: "Warning" },
  down: { color: "error", text: "Down" },
};

export function StatusCard({
  title,
  status,
  detail,
}: {
  title: string;
  status: Status;
  detail?: string;
}) {
  const meta = statusMeta[status];
  return (
    <Card size="small" title={title} extra={<Tag color={meta.color}>{meta.text}</Tag>}>
      {detail ? <p className="m-0 font-mono text-xs opacity-60">{detail}</p> : null}
    </Card>
  );
}
