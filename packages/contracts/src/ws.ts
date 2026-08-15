// ============================================================
// WebSocket 协议 —— 单一契约源（F13）
//
// 客户端 → 服务端：扁平结构 `{command, ...}`，与服务端 ClientCommand
// （io-backend/crates/server/src/ws.rs）一一对应，禁止嵌套包络。
// 服务端 → 客户端：`{type, ...}` 判别联合，与 point/types.rs WsDataMessage、
// WsConfigChangeMessage、alarm/persist.rs 广播载荷一致。
// ============================================================

import type {
  AlarmEventType,
  AlarmOccurrence,
  AlarmRule,
  AlarmStreamEvent,
  AlarmSeverity,
  AlarmStatus,
  AlarmCondition,
  SoeRecord,
} from "./api";

// ---- 客户端 → 服务端 ----

export interface ControlMessage {
  command: "control";
  variableId: string;
  /** 数值或布尔（AO/DO 写点）；后端 ControlValue 不再静默转 f64 */
  value: number | boolean;
}

export interface SubscribeMessage {
  command: "subscribe";
  /** 空数组表示取消过滤、接收全部点 */
  variableIds: string[];
}

export interface HeartbeatMessage {
  command: "heartbeat";
}

export type WsClientMessage =
  ControlMessage | SubscribeMessage | HeartbeatMessage;

// ---- 服务端 → 客户端 ----

/** 单点值（point/types.rs PointValue；id 为后端点标识） */
export interface PointValue {
  id: string;
  value: PointScalar;
  quality: string;
  timestamp: number;
}

export type PointScalar = number | boolean | string | null;

/** 初始全量快照（连接建立后第一帧） */
export interface SnapshotMessage {
  type: "snapshot";
  data: PointValue[];
}

/** 周期数据推送 */
export interface DataMessage {
  type: "data";
  data: PointValue[];
}

/** 点位配置变更通知（point/types.rs WsConfigChangeMessage） */
export interface ConfigChangeMessage {
  type: "config_change";
  action: string;
  variable_id: string;
  plugin_id: number;
}

/** 冗余角色变更（WS 服务端收到 standby 后断开全部客户端） */
export interface RoleMessage {
  type: "role";
  state: string;
}

/** 报警明细事件（persist.rs alarm_update 载荷；event_type 为 snake_case） */
export interface AlarmUpdateMessage {
  type: "alarm_update";
  data: {
    event_type: AlarmEventType;
    occurrence: AlarmOccurrence;
  };
}

/** SOE 变位推送 */
export interface SoeMessage {
  type: "soe";
  data: SoeRecord[];
}

/** 连接后初始活跃报警快照 */
export interface AlarmSnapshotMessage {
  type: "alarm_snapshot";
  data: AlarmOccurrence[];
}

/** 连接后初始报警规则 / 规则全量刷新 */
export interface AlarmRulesMessage {
  type: "alarm_rules";
  data: AlarmRule[];
}

/** 规则变更通知（无载荷，客户端应重新拉取） */
export interface AlarmRulesChangedMessage {
  type: "alarm_rules_changed";
}

export type WsServerEnvelope =
  | SnapshotMessage
  | DataMessage
  | ConfigChangeMessage
  | RoleMessage
  | AlarmUpdateMessage
  | SoeMessage
  | AlarmSnapshotMessage
  | AlarmRulesMessage
  | AlarmRulesChangedMessage;

// ---- 运行时类型守卫（供 WebSocketClient 等消费方做受信解析）----

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isAlarmSeverity(v: unknown): v is AlarmSeverity {
  return v === "critical" || v === "major" || v === "minor" || v === "warning";
}

export function isAlarmStatus(v: unknown): v is AlarmStatus {
  return v === "active" || v === "acknowledged" || v === "recovered";
}

export function isAlarmCondition(v: unknown): v is AlarmCondition {
  return (
    v === "high" ||
    v === "low" ||
    v === "equal" ||
    v === "notEqual" ||
    v === "change"
  );
}

export function isAlarmEventType(v: unknown): v is AlarmEventType {
  return (
    v === "trigger" || v === "ack" || v === "recover" || v === "rule_disabled"
  );
}

export function isPointValue(v: unknown): v is PointValue {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    (typeof v.value === "number" ||
      typeof v.value === "boolean" ||
      typeof v.value === "string" ||
      v.value === null) &&
    typeof v.quality === "string" &&
    typeof v.timestamp === "number"
  );
}

export function isAlarmRule(v: unknown): v is AlarmRule {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.variableId === "string" &&
    typeof v.name === "string" &&
    typeof v.description === "string" &&
    isAlarmSeverity(v.severity) &&
    typeof v.group === "string" &&
    isAlarmCondition(v.condition) &&
    typeof v.threshold === "number" &&
    typeof v.enabled === "boolean" &&
    typeof v.hysteresis === "number" &&
    typeof v.confirmMs === "number"
  );
}

export function isAlarmOccurrence(v: unknown): v is AlarmOccurrence {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "string" &&
    typeof v.ruleId === "string" &&
    typeof v.variableId === "string" &&
    typeof v.name === "string" &&
    isAlarmSeverity(v.severity) &&
    typeof v.group === "string" &&
    typeof v.message === "string" &&
    (typeof v.value === "number" || typeof v.value === "boolean") &&
    typeof v.threshold === "number" &&
    isAlarmStatus(v.status) &&
    typeof v.triggeredAt === "number" &&
    (typeof v.recoveredAt === "number" || v.recoveredAt === null) &&
    typeof v.recoveredReason === "string" &&
    (typeof v.acknowledgedAt === "number" || v.acknowledgedAt === null) &&
    typeof v.acknowledgedBy === "string"
  );
}

export function isSoeRecord(v: unknown): v is SoeRecord {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "number" &&
    typeof v.seq === "number" &&
    typeof v.variableId === "string" &&
    (typeof v.value === "number" || typeof v.value === "boolean") &&
    (v.quality === "good" ||
      v.quality === "bad" ||
      v.quality === "uncertain") &&
    typeof v.deviceTime === "number" &&
    typeof v.receiveTime === "number" &&
    typeof v.source === "string"
  );
}

export function isAlarmStreamEvent(v: unknown): v is AlarmStreamEvent {
  if (!isRecord(v)) return false;
  return (
    typeof v.id === "number" &&
    typeof v.occurrenceId === "string" &&
    isAlarmEventType(v.eventType) &&
    typeof v.atMs === "number" &&
    typeof v.byUser === "string" &&
    (typeof v.value === "number" || typeof v.value === "boolean") &&
    typeof v.message === "string"
  );
}

/**
 * 受信解析服务端 JSON 帧：只有匹配判别联合结构才返回消息，
 * 未知/畸形帧一律返回 null（不再做 `p.id ?? p.variableId ?? p.tag`
 * 式的多命名兼容，字段名以契约为准）。
 */
export function parseWsEnvelope(raw: unknown): WsServerEnvelope | null {
  if (!isRecord(raw) || typeof raw.type !== "string") return null;
  switch (raw.type) {
    case "snapshot":
    case "data":
      if (!Array.isArray(raw.data) || !raw.data.every(isPointValue))
        return null;
      return { type: raw.type, data: raw.data } as WsServerEnvelope;
    case "config_change":
      if (
        typeof raw.action !== "string" ||
        typeof raw.variable_id !== "string" ||
        typeof raw.plugin_id !== "number"
      ) {
        return null;
      }
      return {
        type: "config_change",
        action: raw.action,
        variable_id: raw.variable_id,
        plugin_id: raw.plugin_id,
      };
    case "role":
      if (typeof raw.state !== "string") return null;
      return { type: "role", state: raw.state };
    case "alarm_update": {
      const d = raw.data;
      if (
        !isRecord(d) ||
        !isAlarmEventType(d.event_type) ||
        !isAlarmOccurrence(d.occurrence)
      ) {
        return null;
      }
      return {
        type: "alarm_update",
        data: { event_type: d.event_type, occurrence: d.occurrence },
      };
    }
    case "soe":
      if (!Array.isArray(raw.data) || !raw.data.every(isSoeRecord)) return null;
      return { type: "soe", data: raw.data };
    case "alarm_snapshot":
      if (!Array.isArray(raw.data) || !raw.data.every(isAlarmOccurrence)) {
        return null;
      }
      return { type: "alarm_snapshot", data: raw.data };
    case "alarm_rules":
      if (!Array.isArray(raw.data) || !raw.data.every(isAlarmRule)) return null;
      return { type: "alarm_rules", data: raw.data };
    case "alarm_rules_changed":
      return { type: "alarm_rules_changed" };
    default:
      return null;
  }
}

/** 受信解析客户端消息（供契约测试使用） */
export function parseClientMessage(raw: unknown): WsClientMessage | null {
  if (!isRecord(raw) || typeof raw.command !== "string") return null;
  switch (raw.command) {
    case "control":
      if (
        typeof raw.variableId !== "string" ||
        (typeof raw.value !== "number" && typeof raw.value !== "boolean")
      ) {
        return null;
      }
      return {
        command: "control",
        variableId: raw.variableId,
        value: raw.value,
      };
    case "subscribe":
      if (
        !Array.isArray(raw.variableIds) ||
        !raw.variableIds.every((v) => typeof v === "string")
      ) {
        return null;
      }
      return { command: "subscribe", variableIds: raw.variableIds };
    case "heartbeat":
      return { command: "heartbeat" };
    default:
      return null;
  }
}
