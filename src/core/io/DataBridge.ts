import { VariableManager } from "../variables/VariableManager";
import { DataSource } from "./DataSource";
import { WebSocketClient } from "./WebSocketClient";
import { IEC104Simulator } from "./IEC104Simulator";
import type { ConnectionStatus, DataSourceType } from "./types";

// ============================================================
// DataBridge — I/O 数据源 ↔ VariableManager 桥接
// 统一管理数据源生命周期，将外部数据路由到变量管理器
// ============================================================

export type ActiveSource = "simulation" | "iec104" | "websocket";

export class DataBridge {
  private variableManager: VariableManager;
  private sources: Map<string, DataSource> = new Map();
  private activeSource: ActiveSource = "simulation";
  private statusListeners: Set<
    (source: string, status: ConnectionStatus) => void
  > = new Set();

  // IEC 104 模拟器内置
  iec104Simulator: IEC104Simulator;
  // WebSocket 客户端
  wsClient: WebSocketClient;

  constructor(variableManager: VariableManager) {
    this.variableManager = variableManager;

    // 创建内置数据源
    this.iec104Simulator = new IEC104Simulator({ name: "IEC 104 模拟" });
    this.wsClient = new WebSocketClient();

    // 注册
    this.sources.set("iec104", this.iec104Simulator);
    this.sources.set("websocket", this.wsClient);
  }

  /** 设置当前活跃数据源 */
  setActiveSource(type: ActiveSource): void {
    // 断开当前
    this.disconnectAll();

    this.activeSource = type;

    if (type === "iec104") {
      this.connectSource("iec104");
    } else if (type === "websocket") {
      this.connectSource("websocket");
    }
    // "simulation" 由 VariableManager 内置处理
  }

  /** 启动当前数据源 */
  start(): void {
    if (this.activeSource === "simulation") {
      this.variableManager.startSimulation(800);
    } else {
      this.connectSource(this.activeSource);
    }
  }

  /** 停止 */
  stop(): void {
    this.variableManager.stopSimulation();
    this.disconnectAll();
  }

  /** 发送控制命令 */
  sendControl(variableId: string, value: number | boolean): void {
    const source = this.getActiveDataSource();
    if (source?.isConnected) {
      source.send(variableId, value);
    }
    // 无论如何，直接更新变量值
    this.variableManager.setValue(variableId, value);
  }

  /** 获取当前活跃数据源 */
  get active(): ActiveSource {
    return this.activeSource;
  }

  /** 获取数据源连接状态 */
  getStatus(source: string): ConnectionStatus {
    return this.sources.get(source)?.connectionStatus ?? "disconnected";
  }

  /** 订阅状态变化 */
  onStatus(cb: (source: string, status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  /** 关联变量：将数据源的点路由到 VariableManager */
  bindVariables(variableIds: string[]): void {
    for (const source of this.sources.values()) {
      source.subscribe({
        onData: (point) => {
          if (variableIds.includes(point.id) || variableIds.length === 0) {
            this.variableManager.setValue(point.id, point.value, point.quality);
          }
        },
        onStatus: (status) => {},
        onError: (err) => console.warn("[DataBridge]", err.message),
      });
    }
  }

  // ---- 底层 ----

  private connectSource(name: string): void {
    const source = this.sources.get(name);
    if (!source) return;

    source.subscribe({
      onData: (point) => {
        this.variableManager.setValue(point.id, point.value, point.quality);
      },
      onStatus: (status) => {
        this.notifyStatus(name, status);
      },
      onError: (err) => {
        console.warn("[DataBridge] " + name + ":", err.message);
      },
    });

    source.connect().catch((err) => {
      console.error("[DataBridge] 连接失败 " + name + ":", err.message);
    });
  }

  private disconnectAll(): void {
    for (const source of this.sources.values()) {
      source.disconnect();
    }
  }

  private getActiveDataSource(): DataSource | undefined {
    if (this.activeSource === "iec104") return this.iec104Simulator;
    if (this.activeSource === "websocket") return this.wsClient;
    return undefined;
  }

  private notifyStatus(source: string, status: ConnectionStatus): void {
    for (const cb of this.statusListeners) cb(source, status);
  }
}
