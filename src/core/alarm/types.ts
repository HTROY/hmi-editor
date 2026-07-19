// ============================================================
// 报警系统类型定义
// ============================================================

export type AlarmSeverity = "critical" | "major" | "minor" | "warning";
export type AlarmStatus = "active" | "acknowledged" | "recovered" | "shelved";

export interface AlarmDef {
  id: string;
  variableId: string;
  name: string;
  description: string;
  severity: AlarmSeverity;
  group: string;
  /** 触发条件 */
  condition: "high" | "low" | "equal" | "notEqual" | "change";
  threshold: number;
  /** 是否启用 */
  enabled: boolean;
}

export interface AlarmEvent {
  id: string;
  alarmId: string;
  variableId: string;
  name: string;
  severity: AlarmSeverity;
  status: AlarmStatus;
  message: string;
  value: number | boolean;
  threshold: number;
  group: string;
  triggeredAt: number;
  acknowledgedAt: number | null;
  acknowledgedBy: string | null;
  recoveredAt: number | null;
  /** SOE 时间戳（毫秒精度） */
  soeTimestamp: number;
}

/** SOE 事件记录 */
export interface SOERecord {
  id: string;
  variableId: string;
  value: number | boolean;
  quality: "good" | "bad" | "uncertain";
  timestamp: number; // 毫秒
  source: string; // 来源（IEC104/WebSocket/Operator）
}
