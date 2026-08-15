// ============================================================
// 共享 REST DTO —— 前后端 API 契约的单一来源（F13）
//
// 对应 io-backend/crates 中的 serde 结构：
// - 报警/SOE：io-backend/crates/alarm/src/types.rs（camelCase）
// - 插件/点位：io-backend/crates/db/src/repo.rs（snake_case 行结构）
// - 监控：io-backend/crates/monitor/src/types.rs
// - 冗余：io-backend/crates/web/src/redundancy.rs
//
// 主编辑器（src/core/alarm/types.ts 等）与管理 UI（io-backend/web-ui）
// 都从这里导入，禁止各自维护手写镜像；字段名与后端 JSON 完全一致。
// ============================================================

// ---- Alarm & SOE（camelCase，与后端 alarm/types.rs 一致）----

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

export interface AlarmRuleUpsert {
  variableId: string;
  name: string;
  description: string;
  severity: AlarmSeverity;
  group: string;
  condition: AlarmCondition;
  threshold: number;
  enabled: boolean;
  hysteresis: number;
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
export interface SoeRecord {
  id: number;
  seq: number;
  variableId: string;
  value: number | boolean;
  quality: "good" | "bad" | "uncertain";
  deviceTime: number;
  receiveTime: number;
  source: string;
}

export interface Paged<T> {
  total: number;
  items: T[];
}

/** 报警历史查询参数（GET /api/alarm/history） */
export interface AlarmHistoryQuery {
  from?: number;
  to?: number;
  severity?: AlarmSeverity | "";
  group?: string;
  variableId?: string;
  status?: AlarmStatus | "unacknowledged" | "";
  page?: number;
  pageSize?: number;
}

/** SOE 查询参数（GET /api/soe） */
export interface SOEQuery {
  from?: number;
  to?: number;
  variableId?: string;
  quality?: string;
  page?: number;
  pageSize?: number;
}

// ---- Plugins / Points（snake_case，与 db/repo.rs 行结构一致）----

export interface PluginRow {
  id: number;
  name: string;
  wasm_file: string;
  config_json: string;
  enabled: boolean;
  redundancy_group: string;
  /** 实例冗余角色（primary|backup）；全站统一字段名，禁止再用 plugin_role */
  redundancy_role: string;
  priority: number;
}

export interface PointRow {
  id: number;
  plugin_id: number;
  variable_id: string;
  address: string;
  data_type: string;
  byte_order: string;
  scale: number;
  offset_val: number;
  var_type: string;
  description: string;
  plugin_name?: string;
  hmi_id?: string;
  redundancy_group: string;
  /** 实例冗余角色（与 PluginRow / 后端 PointView 一致）。 */
  redundancy_role: string;
}

export interface PointUpsert {
  plugin_id: number;
  variable_id: string;
  address: string;
  data_type: string;
  byte_order: string;
  scale: number;
  offset_val: number;
  var_type: string;
  description?: string;
}

// ---- Monitor（monitor/types.rs）----

export interface PluginStatus {
  name: string;
  wasm_file: string;
  /** 0=disconnected, 1=connecting, 2=connected, 3=error */
  connection_state: number;
  connection_label: string;
  scan_count: number;
  error_count: number;
  last_scan_time_ms: number;
  last_error: string;
  last_error_time_ms: number;
  uptime_ms: number;
  start_time_ms: number;
}

export interface PacketLogEntry {
  timestamp_ms: number;
  direction: string;
  protocol: string;
  length: number;
  hex_dump: string;
  summary: string;
}

export interface LivePointInfo {
  variable_id: string;
  address: string;
  var_type: string;
  value: string | number | boolean | null;
  quality: string;
  timestamp_ms: number;
  age_ms: number;
  data_type: string;
  byte_order: string;
  scale: number;
  offset_val: number;
}

export interface MonitorSnapshot {
  server_uptime_ms: number;
  plugins: PluginStatus[];
  total_scans: number;
  total_errors: number;
  total_points: number;
  active_ws_clients: number;
}

export interface PluginHistorySample {
  name: string;
  scans: number;
  errors: number;
}

export interface HistorySample {
  timestamp_ms: number;
  total_scans: number;
  total_errors: number;
  per_plugin: PluginHistorySample[];
}

export interface MonitorHistory {
  samples: HistorySample[];
  scan_interval_ms: number;
}

export interface ConfigExport {
  scan_interval_ms: number;
  plugins: {
    name: string;
    wasm_file: string;
    config_json: Record<string, unknown>;
    enabled: boolean;
    points: PointUpsert[];
  }[];
}

// ---- Redundancy（web/redundancy.rs）----

export interface RedundancyConfig {
  enabled: boolean;
  node_id: string;
  role: "primary" | "backup";
  peer_url: string;
  peer_ws_port: number;
  heartbeat_interval_ms: number;
  failover_threshold: number;
  failback_delay_ms: number;
  full_snapshot_interval_ms: number;
  plugin_unhealthy_threshold: number;
  plugin_promotion_cooldown_ms: number;
  instance_failover_threshold: number;
  instance_failback_enabled: boolean;
  instance_failback_delay_ms: number;
  instance_switch_cooldown_ms: number;
}

export interface PeerStatus {
  reachable: boolean;
  active: boolean;
  node_id: string;
  config_version: number;
  last_seen_ms: number;
  rtt_ms: number;
  rtt_avg_ms: number;
}

export interface SyncStats {
  last_sync_ms: number;
  points_received: number;
  points_pushed: number;
}

export interface RedundancyEvent {
  time_ms: number;
  kind: string;
  message: string;
}

export interface RedundancyPoint {
  id: string;
  value: string | number | boolean | null;
  quality: string;
  timestamp: number;
}

export interface RedundancyStatus {
  enabled: boolean;
  node_id: string;
  role: string;
  state: string;
  config_version: number;
  uptime_ms: number;
  peer: PeerStatus;
  sync: SyncStats;
  events: RedundancyEvent[];
  rtt_history: number[];
  synced_points: RedundancyPoint[];
  split_brain: boolean;
  failover_count: number;
  heartbeat_failures: number;
}

export interface InstanceMemberStatus {
  name: string;
  role: string;
  priority: number;
  is_active: boolean;
  connection_state: number;
  connection_label: string;
}

export interface InstanceGroupStatus {
  group: string;
  members: InstanceMemberStatus[];
  active_instance: string;
  consecutive_failures: number;
  last_switch_ms: number;
  last_switch_reason: string;
  switch_count: number;
}
