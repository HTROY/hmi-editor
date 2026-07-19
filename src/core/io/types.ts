// ============================================================
// I/O 层类型定义
// ============================================================

/** 数据源类型 */
export type DataSourceType = "simulation" | "websocket" | "iec104" | "opcua";

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
