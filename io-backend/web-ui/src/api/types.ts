// API types mirroring the Rust serde structs (io-backend/crates/db/src/repo.rs, io-backend/crates/monitor/src/types.rs)

export interface PluginRow {
  id: number;
  name: string;
  wasm_file: string;
  config_json: string;
  enabled: boolean;
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
