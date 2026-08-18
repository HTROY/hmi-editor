// ============================================================
// 历史数据系统类型
// ============================================================

export interface HistoryPoint {
  variableId: string;
  value: number;
  timestamp: number;
}

export interface HistoryQuery {
  variableIds: string[];
  from: number;
  to: number;
  interval: "raw" | "1s" | "10s" | "1m" | "5m" | "1h";
}

export interface TrendConfig {
  variableId: string;
  label: string;
  color: string;
  min: number;
  max: number;
  unit: string;
}
