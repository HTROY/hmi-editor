import { Tag } from "antd";
import type { AlarmSeverity } from "../api/types";

/** 报警级别 → 颜色/中文名（唯一来源，供表格列与下拉选项共用）。 */
export const SEVERITY_META: Record<
  AlarmSeverity,
  { color: string; label: string }
> = {
  critical: { color: "red", label: "紧急" },
  major: { color: "orange", label: "严重" },
  minor: { color: "gold", label: "一般" },
  warning: { color: "blue", label: "预警" },
};

export const SEVERITY_OPTIONS = Object.entries(SEVERITY_META).map(
  ([value, meta]) => ({ value, label: meta.label })
);

export default function SeverityTag({ severity }: { severity: AlarmSeverity }) {
  const meta = SEVERITY_META[severity];
  return <Tag color={meta?.color}>{meta?.label ?? severity}</Tag>;
}
