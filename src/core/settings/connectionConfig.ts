import type { ActiveSource } from "../io";
import { createStorage } from "../platform/storage";
import type { StorageLike } from "../platform/storage";

// ============================================================
// connectionConfig — 编辑器级数据连接设置持久化
// 与工程自动保存（IndexedDB 快照）分离，只存面板配置本身
// 存储访问统一走 platform/storage（F17）
// ============================================================

export interface ConnectionConfig {
  activeSource: ActiveSource;
  wsUrl: string;
  iec104Host: string;
  iec104Port: number;
  ioBackendUrl: string;
  ioBackendApiUrl: string;
  ioBackendBackupUrl: string;
  ioBackendBackupApiUrl: string;
}

export const CONNECTION_CONFIG_STORAGE_KEY = "hmi_connection_config";

export const DEFAULT_CONNECTION_CONFIG: ConnectionConfig = {
  activeSource: "simulation",
  wsUrl: "ws://localhost:8080/iscs/data",
  iec104Host: "192.168.1.100",
  iec104Port: 2404,
  ioBackendUrl: "ws://localhost:8080/iscs/data",
  ioBackendApiUrl: "http://localhost:8081",
  ioBackendBackupUrl: "",
  ioBackendBackupApiUrl: "",
};

export type { StorageLike } from "../platform/storage";

function isConnectionConfig(value: unknown): value is ConnectionConfig {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.activeSource === "string" &&
    typeof c.wsUrl === "string" &&
    typeof c.iec104Host === "string" &&
    typeof c.iec104Port === "number" &&
    typeof c.ioBackendUrl === "string" &&
    typeof c.ioBackendApiUrl === "string" &&
    typeof c.ioBackendBackupUrl === "string" &&
    typeof c.ioBackendBackupApiUrl === "string"
  );
}

export function loadConnectionConfig(
  storage?: StorageLike
): ConnectionConfig | null {
  const s = createStorage("", storage);
  const parsed: unknown = s.getJSON(CONNECTION_CONFIG_STORAGE_KEY);
  return isConnectionConfig(parsed) ? parsed : null;
}

export function saveConnectionConfig(
  config: ConnectionConfig,
  storage?: StorageLike
): void {
  const s = createStorage("", storage);
  s.setJSON(CONNECTION_CONFIG_STORAGE_KEY, config);
}
