/** 点值展示：null 显示 "--"，数字整型原样、小数 3 位，布尔显示 1/0。 */
export function formatPointValue(
  v: string | number | boolean | null | undefined
): string {
  if (v === null || v === undefined) return "--";
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : v.toFixed(3);
  }
  if (typeof v === "boolean") return v ? "1" : "0";
  return String(v);
}

interface PointValueCellProps {
  value: string | number | boolean | null | undefined;
  /** 非 stale 时的文字颜色（stale 一律降为继承色并半透明）。 */
  color?: string;
  stale?: boolean;
  weight?: number;
}

/** 等宽点值单元格：Monitor 与 RedundancyMonitor 共用。 */
export default function PointValueCell({
  value,
  color,
  stale = false,
  weight = 600,
}: PointValueCellProps) {
  return (
    <span
      className="mono"
      style={{
        color: stale ? "inherit" : color,
        opacity: stale ? 0.4 : 1,
        fontWeight: weight,
      }}
    >
      {formatPointValue(value)}
    </span>
  );
}
