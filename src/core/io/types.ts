// ============================================================
// I/O 层类型定义
// ============================================================

/** 数据源类型 */
export type DataSourceType =
  "simulation" | "websocket" | "iec104" | "opcua" | "io_backend";

/** 连接状态 */
export type ConnectionStatus =
  "disconnected" | "connecting" | "connected" | "error";

/** 数据点更新 */
export interface DataPoint {
  id: string;
  value: number | boolean;
  quality: "good" | "bad" | "uncertain";
  timestamp: number;
}

/** 数据源配置基类 */
export interface DataSourceConfig {
  type: DataSourceType;
  name: string;
  enabled: boolean;
}

/** WebSocket 配置 */
export interface WebSocketConfig extends DataSourceConfig {
  type: "websocket";
  url: string;
  protocol: string;
  reconnectInterval: number;
  heartbeatInterval: number;
}

/** IEC 104 配置 */
export interface IEC104Config extends DataSourceConfig {
  type: "iec104";
  host: string;
  port: number;
  commonAddress: number;
  originatorAddress: number;
  reconnectInterval: number;
}

/** 数据源事件回调 */
export type DataSourceCallback = {
  onData: (point: DataPoint) => void;
  onStatus: (status: ConnectionStatus) => void;
  onError: (error: Error) => void;
};

/** 插件信息（来自后端 Monitor API） */
export interface PluginInfo {
  name: string;
  wasm_file: string;
  connection_state: number;
  connection_label: string;
  scan_count: number;
  error_count: number;
  last_scan_time_ms: number;
  last_error: string;
  last_error_time_ms: number;
  uptime_ms: number;
}

/** 实时点位信息（来自后端 Monitor API） */
export interface LivePointInfo {
  variable_id: string;
  address: string;
  var_type: string;
  value: number | boolean | null;
  quality: string;
  timestamp_ms: number;
  age_ms: number;
  data_type: string;
  byte_order: string;
  scale: number;
  offset_val: number;
}

/** 监控快照（来自 GET /api/monitor/overview） */
export interface MonitorSnapshot {
  server_uptime_ms: number;
  plugins: PluginInfo[];
  total_scans: number;
  total_errors: number;
  total_points: number;
  active_ws_clients: number;
}
