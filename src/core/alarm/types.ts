// ============================================================
// 报警与 SOE 领域类型（与后端 hmi-io-alarm 协议对齐）
// ============================================================

export type AlarmSeverity = "critical" | "major" | "minor" | "warning";
export type AlarmStatus = "active" | "acknowledged" | "recovered";
export type AlarmCondition = "high" | "low" | "equal" | "notEqual" | "change";
export type AlarmEventType = "trigger" | "ack" | "recover" | "rule_disabled";

/** 报警规则（后端 DB 为唯一事实来源） */
export interface AlarmRule {
  id: string;
  variableId: string;
  name: string;
  description: string;
  severity: AlarmSeverity;
  group: string;
  condition: AlarmCondition;
  threshold: number;
  enabled: boolean;
  /** 滞回：高限恢复阈值为 threshold-hysteresis，低限为 threshold+hysteresis */
  hysteresis: number;
  /** 持续超限确认时间（毫秒），0 表示立即触发 */
  confirmMs: number;
}

/** 报警发生记录（一次报警从触发到恢复的摘要） */
export interface AlarmOccurrence {
  id: string;
  ruleId: string;
  variableId: string;
  name: string;
  severity: AlarmSeverity;
  group: string;
  message: string;
  value: number | boolean;
  threshold: number;
  status: AlarmStatus;
  triggeredAt: number;
  recoveredAt: number | null;
  recoveredReason: string;
  acknowledgedAt: number | null;
  acknowledgedBy: string;
}

/** 报警明细事件（触发/确认/恢复/规则停用） */
export interface AlarmStreamEvent {
  id: number;
  occurrenceId: string;
  eventType: AlarmEventType;
  atMs: number;
  byUser: string;
  value: number | boolean;
  message: string;
}

/** SOE 记录（点位变位，毫秒精度） */
export interface SOERecord {
  id: number;
  seq: number;
  variableId: string;
  value: number | boolean;
  quality: "good" | "bad" | "uncertain";
  deviceTime: number;
  receiveTime: number;
  source: string;
}

/** WS alarm_update 消息载荷 */
export interface AlarmUpdateMessage {
  eventType: AlarmEventType;
  occurrence: AlarmOccurrence;
}

export interface AlarmHistoryQuery {
  from?: number;
  to?: number;
  severity?: AlarmSeverity | "";
  group?: string;
  variableId?: string;
  status?: AlarmStatus | "";
  page?: number;
  pageSize?: number;
}

export interface SOEQuery {
  from?: number;
  to?: number;
  variableId?: string;
  quality?: string;
  page?: number;
  pageSize?: number;
}

export interface Paged<T> {
  total: number;
  items: T[];
}
