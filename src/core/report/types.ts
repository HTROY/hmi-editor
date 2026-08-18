// ============================================================
// 报表系统类型
// ============================================================

export type ReportType = "daily" | "hourly" | "event" | "custom";

export interface ReportConfig {
  id: string;
  name: string;
  type: ReportType;
  variableIds: string[];
  description: string;
  enabled: boolean;
}

export interface ReportRow {
  time: string;
  values: Record<string, number>;
}

export interface ReportData {
  config: ReportConfig;
  generatedAt: string;
  rows: ReportRow[];
}
