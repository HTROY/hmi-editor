import { DataSource } from "./DataSource";
import type { WebSocketConfig, DataPoint } from "./types";
import {
  parseWsEnvelope,
  type PointValue,
  type WsServerEnvelope,
} from "@hmi/contracts";
import { createLogger } from "../platform/logger";

// ============================================================
// WebSocketClient — WebSocket 数据源
// 连接后端实时数据服务，推送变量值变化
// 协议契约单一来源：packages/contracts/src/ws.ts（F13）
// ============================================================

const logger = createLogger("WebSocket");

export type ConfigChangeHandler = (event: {
  action: string;
  variableId: string;
  pluginId: number;
}) => void;

/** 报警/SOE 推送处理（alarm_snapshot/alarm_update/soe/alarm_rules/...） */
export type AlarmMessageHandler = (msg: WsServerEnvelope) => void;

// ------------------------------------------------------------
// 客户端 → 后端 WS 协议（与服务端 ClientCommand 一一对应，扁平结构）
// 后端期望 `{command, variableId, value}` / `{command, variableIds}`，
// 不要再用 `{command, value:{...}}` 嵌套包络。
// ------------------------------------------------------------

export type { WsClientMessage } from "@hmi/contracts";

export class WebSocketClient extends DataSource {
  declare config: WebSocketConfig;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private shouldReconnect = false;
  private urlIndex = 0;
  private configChangeHandlers: Set<ConfigChangeHandler> = new Set();
  private alarmHandlers: Set<AlarmMessageHandler> = new Set();

  constructor(config: Partial<WebSocketConfig> = {}) {
    const urls = config.urls?.length
      ? config.urls
      : [config.url ?? "ws://localhost:8080/iscs/data"];
    super({
      type: "websocket",
      name: config.name ?? "WebSocket 数据源",
      enabled: config.enabled ?? true,
      url: urls[0],
      urls,
      protocol: config.protocol ?? "",
      reconnectInterval: config.reconnectInterval ?? 5000,
      heartbeatInterval: config.heartbeatInterval ?? 30000,
    } as WebSocketConfig);
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.shouldReconnect = true;
    this.emitStatus("connecting");

    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(
          this.getUrls()[this.urlIndex] ?? this.config.url
        );
        ws.onopen = () => {
          logger.info(
            "Connected to",
            this.getUrls()[this.urlIndex] ?? this.config.url
          );
          this.ws = ws;
          this.emitStatus("connected");
          this.startHeartbeat();
          resolve();
        };

        ws.onmessage = (event) => {
          if (typeof event.data !== "string") return;
          logger.debug("Raw message received, length:", event.data.length);
          try {
            this.handleMessage(JSON.parse(event.data));
          } catch {
            // 尝试按行解析（多个 JSON 对象）
            const lines = event.data.split("\n").filter(Boolean);
            for (const line of lines) {
              try {
                this.handleMessage(JSON.parse(line));
              } catch (_e) {
                /* skip malformed */
              }
            }
          }
        };

        ws.onerror = (err) => {
          logger.error("Connection error:", err);
          this.emitError(
            new Error(
              "WebSocket 连接错误: " +
                (err instanceof Error ? err.message : String(err))
            )
          );
          reject(err);
        };

        ws.onclose = (ev) => {
          logger.info("Closed, code:", ev.code, "reason:", ev.reason);
          this.ws = null;
          this.stopHeartbeat();
          this.emitStatus("disconnected");
          const urls = this.getUrls();
          this.urlIndex = (this.urlIndex + 1) % urls.length;
          this.scheduleReconnect();
        };
      } catch (err) {
        this.emitError(err as Error);
        reject(err);
      }
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    this.clearReconnect();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.emitStatus("disconnected");
  }

  /** 发送一条扁平协议消息 `{command, ...payload}`（后端约定的结构） */
  send(command: string, payload?: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.emitError(new Error("WebSocket 未连接"));
      return;
    }
    const msg = JSON.stringify({ command, ...payload });
    this.ws.send(msg);
  }

  /** 订阅单个变量（等价于订阅列表） */
  subscribeVariable(variableId: string): void {
    this.subscribeVariables([variableId]);
  }

  /** 批量订阅变量列表；空数组表示取消过滤、接收全部点 */
  subscribeVariables(variableIds: string[]): void {
    this.send("subscribe", { variableIds });
  }

  /** 控制命令：value 支持 number 与 boolean（AO/DO） */
  sendControl(variableId: string, value: number | boolean): void {
    this.send("control", { variableId, value });
  }

  /** 订阅配置变更通知 */
  onConfigChange(handler: ConfigChangeHandler): () => void {
    this.configChangeHandlers.add(handler);
    return () => this.configChangeHandlers.delete(handler);
  }

  /** 订阅报警/SOE 推送（alarm_snapshot/alarm_update/soe/alarm_rules/...） */
  onAlarmMessage(handler: AlarmMessageHandler): () => void {
    this.alarmHandlers.add(handler);
    return () => this.alarmHandlers.delete(handler);
  }

  // ---- 内部 ----

  private handleMessage(raw: unknown): void {
    // 受信解析：只接受契约定义的 {type, ...} 判别联合（packages/contracts）
    const msg = parseWsEnvelope(raw);
    if (!msg) {
      logger.debug("忽略无法识别的 WS 消息:", raw);
      return;
    }

    switch (msg.type) {
      // 初始快照与周期数据
      case "snapshot":
      case "data":
        for (const p of msg.data) {
          this.emitData(toDataPoint(p));
        }
        return;

      // 配置变更通知
      case "config_change":
        for (const handler of this.configChangeHandlers) {
          handler({
            action: msg.action,
            variableId: msg.variable_id,
            pluginId: msg.plugin_id,
          });
        }
        return;

      // Alarm & SOE 推送
      case "alarm_update":
      case "soe":
      case "alarm_snapshot":
      case "alarm_rules":
      case "alarm_rules_changed":
        for (const handler of this.alarmHandlers) {
          handler(msg);
        }
        return;

      // 冗余角色变更（后端会随之断开连接）
      case "role":
        logger.debug("冗余角色变更:", msg.state);
        return;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.config.heartbeatInterval > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.send("heartbeat");
      }, this.config.heartbeatInterval);
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    this.clearReconnect();
    // 有多个地址时快速轮询；单个地址维持原重连间隔
    const delay =
      this.getUrls().length > 1 && this.urlIndex !== 0
        ? 100
        : this.config.reconnectInterval;
    this.reconnectTimer = setTimeout(() => {
      this.emitStatus("connecting");
      this.connect().catch(() => {});
    }, delay);
  }

  private getUrls(): string[] {
    if (this.config.urls && this.config.urls.length > 0) {
      return this.config.urls;
    }
    return [this.config.url];
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  updateConfig(config: Partial<WebSocketConfig>): void {
    const wasConnected = this.isConnected;
    this.disconnect();
    Object.assign(this.config, config);
    if (wasConnected && this.config.enabled) {
      this.connect();
    }
  }
}

/**
 * 契约 PointValue → 内部 DataPoint。
 * 字段名以契约为准（id/value/quality/timestamp），不做多命名兼容；
 * 字符串/空值按数值归一（后端 value 为 serde_json::Value）。
 */
function toDataPoint(p: PointValue): DataPoint {
  const value: number | boolean =
    typeof p.value === "number" || typeof p.value === "boolean"
      ? p.value
      : typeof p.value === "string"
        ? Number(p.value) || 0
        : 0;
  const quality: DataPoint["quality"] =
    p.quality === "good" || p.quality === "bad" || p.quality === "uncertain"
      ? p.quality
      : "good";
  return { id: p.id, value, quality, timestamp: p.timestamp };
}
