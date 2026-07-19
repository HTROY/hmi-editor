import { DataSource } from "./DataSource";
import type { WebSocketConfig, DataPoint } from "./types";

// ============================================================
// WebSocketClient — WebSocket 数据源
// 连接后端实时数据服务，推送变量值变化
// ============================================================

export class WebSocketClient extends DataSource {
  declare config: WebSocketConfig;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private shouldReconnect = false;

  constructor(config: Partial<WebSocketConfig> = {}) {
    super({
      type: "websocket",
      name: config.name ?? "WebSocket 数据源",
      enabled: config.enabled ?? true,
      url: config.url ?? "ws://localhost:8080/iscs/data",
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
        const ws = new WebSocket(this.config.url);
        ws.onopen = () => {
          this.ws = ws;
          this.emitStatus("connected");
          this.startHeartbeat();
          resolve();
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            this.handleMessage(msg);
          } catch {
            // 尝试按行解析（多个 JSON 对象）
            const lines = event.data.split("\n").filter(Boolean);
            for (const line of lines) {
              try {
                this.handleMessage(JSON.parse(line));
              } catch (_e) { /* skip malformed */ }
            }
          }
        };

        ws.onerror = (err) => {
          this.emitError(new Error("WebSocket 连接错误: " + ((err as any)?.message ?? "未知")));
          reject(err);
        };

        ws.onclose = () => {
          this.ws = null;
          this.stopHeartbeat();
          this.emitStatus("disconnected");
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

  send(command: string, value?: any): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.emitError(new Error("WebSocket 未连接"));
      return;
    }
    const msg = JSON.stringify({ command, value, timestamp: Date.now() });
    this.ws.send(msg);
  }

  /** 订阅变量 */
  subscribeVariable(variableId: string): void {
    this.send("subscribe", { variableId });
  }

  /** 控制命令 */
  sendControl(variableId: string, value: number | boolean): void {
    this.send("control", { variableId, value });
  }

  // ---- 内部 ----

  private handleMessage(msg: any): void {
    // 支持多种数据格式
    if (msg.type === "data" || msg.data) {
      const points = Array.isArray(msg.data) ? msg.data : [msg.data ?? msg];
      for (const p of points) {
        this.emitData({
          id: p.id ?? p.variableId ?? p.tag ?? "",
          value: p.value ?? p.val ?? 0,
          quality: p.quality ?? "good",
          timestamp: p.timestamp ?? Date.now(),
        });
      }
    } else if (msg.id || msg.variableId) {
      // 单点格式
      this.emitData({
        id: msg.id ?? msg.variableId,
        value: msg.value ?? msg.val,
        quality: msg.quality ?? "good",
        timestamp: msg.timestamp ?? Date.now(),
      });
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
    this.reconnectTimer = setTimeout(() => {
      this.emitStatus("connecting");
      this.connect().catch(() => {});
    }, this.config.reconnectInterval);
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
