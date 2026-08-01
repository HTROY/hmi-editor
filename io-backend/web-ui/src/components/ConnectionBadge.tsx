import { Badge } from "antd";

const STATE_MAP = [
  { status: "default", text: "未连接" },
  { status: "processing", text: "连接中" },
  { status: "success", text: "已连接" },
  { status: "error", text: "错误" },
] as const;

export function connectionStateMeta(state: number) {
  const meta = STATE_MAP[state] ?? { status: "default" as const, text: "未知" };
  return meta;
}

export default function ConnectionBadge({ state }: { state: number }) {
  const meta = connectionStateMeta(state);
  return <Badge status={meta.status} text={meta.text} />;
}
