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
  /** 主备地址列表（主在前）；缺省时退回 url */
  urls?: string[];
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

// 监控 DTO 单一契约源（F13）：与 web-ui 共用 packages/contracts，
// 字段名与后端 monitor/types.rs 一致，禁止在本文件手写镜像。
import type { PluginStatus } from "@hmi/contracts";

export type {
  PluginStatus,
  LivePointInfo,
  MonitorSnapshot,
} from "@hmi/contracts";
/** 兼容别名：契约中的规范命名为 PluginStatus */
export type PluginInfo = PluginStatus;
