import { Card, Statistic } from "antd";
import type { ReactNode } from "react";
import { useTheme } from "../theme";

interface StatCardProps {
  title: string;
  value: ReactNode;
  icon?: ReactNode;
  color?: string;
  suffix?: ReactNode;
  hint?: string;
  loading?: boolean;
}

export default function StatCard({ title, value, icon, color, suffix, hint, loading }: StatCardProps) {
  const { isDark } = useTheme();
  return (
    <Card size="small" loading={loading} styles={{ body: { padding: 14 } }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {icon && (
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              color,
              background: color
                ? `${color}${isDark ? "26" : "14"}`
                : isDark
                  ? "rgba(59,130,246,0.15)"
                  : "rgba(59,130,246,0.08)",
            }}
          >
            {icon}
          </div>
        )}
        <Statistic
          title={title}
          value={value as never}
          suffix={suffix}
          valueStyle={{ fontSize: 22, fontWeight: 600, color }}
        />
      </div>
      {hint && <div style={{ marginTop: 6, fontSize: 11, opacity: 0.55 }}>{hint}</div>}
    </Card>
  );
}
