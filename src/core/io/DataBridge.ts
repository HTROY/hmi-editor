import { VariableManager } from "../variables/VariableManager";
import type { VariableType } from "../variables/types";
import { DataSource } from "./DataSource";
import { WebSocketClient } from "./WebSocketClient";
import { IEC104Simulator } from "./IEC104Simulator";
import type { ConnectionStatus, DataSourceType, MonitorSnapshot } from "./types";

// ============================================================
// DataBridge — I/O 数据源 → VariableManager 桥接
// 统一管理数据源生命周期，将外部数据路由到变量管理器
// ============================================================

export type ActiveSource = "simulation" | "iec104" | "websocket" | "io_backend";

export class DataBridge {
  private variableManager: VariableManager;
  private sources: Map<string, DataSource> = new Map();
  private activeSource: ActiveSource = "simulation";
  private statusListeners: Set<
    (source: string, status: ConnectionStatus) => void
  > = new Set();

  /** 后端点位标识 → 内部变量 ID 的映射（WebSocket 数据路由用） */
  private pointIdToVarId: Map<string, string> = new Map();
  /** 内部变量 ID → 后端点位标识（控制命令反向路由用） */
  private varIdToPointId: Map<string, string> = new Map();

  // IEC 104 模拟器内置
  iec104Simulator: IEC104Simulator;
  // WebSocket 客户端（也用于连接 IO 后端）
  wsClient: WebSocketClient;

  /** IO 后端 REST API 地址缓存 */
  private apiBaseUrl: string = "http://localhost:8081";

  /** config_change 防抖定时器 */
  private configRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** config_change 监听解除函数 */
  private configChangeUnsub: (() => void) | null = null;
  /** 外部刷新回调（用于通知 UI 更新变量列表） */
  private onVarsRefreshed: (() => void) | null = null;

  constructor(variableManager: VariableManager) {
    this.variableManager = variableManager;

    // 创建内置数据源
    this.iec104Simulator = new IEC104Simulator({ name: "IEC 104 模拟" });
    this.wsClient = new WebSocketClient();

    // 注册
    this.sources.set("iec104", this.iec104Simulator);
    this.sources.set("websocket", this.wsClient);

    // 监听 config_change 自动刷新
    this.setupConfigChangeWatcher();
  }

  /** Get the variable manager (for UI access) */
  get varManager(): VariableManager {
    return this.variableManager;
  }

  /** 设置当前活跃数据源 */
  setActiveSource(type: ActiveSource): void {
    // 断开当前
    this.disconnectAll();

    console.log("[DataBridge] Active source set to:", type);
    this.activeSource = type;

    if (type === "iec104") {
      this.connectSource("iec104");
    } else if (type === "websocket" || type === "io_backend") {
      this.connectSource("websocket");
    }
    // "simulation" 由 VariableManager 内置处理
  }

  /** 启动当前数据源 */
  start(): void {
    if (this.activeSource === "simulation") {
      this.variableManager.startSimulation(800);
    } else {
      this.connectSource(this.activeSource === "io_backend" ? "websocket" : this.activeSource);
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
      // 将内部变量 ID 转换回后端点位标识
      const backendId = this.varIdToPointId.get(variableId) ?? variableId;
      source.send(backendId, value);
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

  /** 订阅状态变更 */
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

  /** 设置 IO 后端 REST API 地址 */
  setApiBaseUrl(url: string): void {
    this.apiBaseUrl = url;
  }

  /** 获取 IO 后端 REST API 地址 */
  getApiBaseUrl(): string {
    return this.apiBaseUrl;
  }

  /** 设置变量刷新回调（用于通知 UI） */
  setOnVarsRefreshed(cb: (() => void) | null): void {
    this.onVarsRefreshed = cb;
  }

  /** 从 IO 后端 Monitor API 获取插件状态快照 */
  async fetchPluginStatuses(): Promise<MonitorSnapshot> {
    const url = `${this.apiBaseUrl}/api/monitor/overview`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return resp.json();
  }

  /** 从 IO 后端 REST API 拉取变量列表并自动导入 */
  async fetchVariablesFromBackend(apiBaseUrl?: string): Promise<number> {
    const base = apiBaseUrl ?? this.apiBaseUrl;
    this.apiBaseUrl = base;
    const url = `${base}/api/points`;
    console.log("[DataBridge] 正在从后端拉取变量列表:", url);
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      }
      const points: Array<{
        id: number;
        plugin_id: number;
        variable_id: string;
        address: string;
        data_type: string;
        byte_order: string;
        scale: number;
        offset_val: number;
        var_type: string;
        description?: string;
      }> = await resp.json();

      console.log(`[DataBridge] 后端返回 ${points.length} 个点`);

      // 清空旧映射
      this.pointIdToVarId.clear();
      this.varIdToPointId.clear();

      const defs = points.map((p) => {
        const varType: VariableType = (["AI","DI","AO","DO"].includes(p.var_type) ? p.var_type as VariableType : "AI");
        const internalId = `p${p.plugin_id}_${p.variable_id}`;
        const backendPointId = String(p.id);

        // 建立双向映射：后端 DB id 和 variable_id 都映射到内部 ID
        this.pointIdToVarId.set(backendPointId, internalId);
        this.pointIdToVarId.set(p.variable_id, internalId);
        // 反向映射：内部 ID → 后端 DB id（控制命令用）
        this.varIdToPointId.set(internalId, backendPointId);

        return {
          id: internalId,
          name: p.variable_id + ` [P${p.plugin_id}]`,
          type: varType,
          address: p.address,
          defaultValue: 0,
          unit: "",
          description: p.description ?? (p.data_type + " / " + p.byte_order),
          group: "IO Backend (plugin " + p.plugin_id + ")",
          min: 0,
          max: (varType === "AI" || varType === "AO") ? 100 : 1,
          alarmHigh: 0,
          alarmLow: 0,
        };
      });

      this.variableManager.replaceAll(defs);
      console.log(`[DataBridge] 变量列表已导入: ${defs.length} 个, 映射表: ${this.pointIdToVarId.size} 条`);
      return defs.length;
    } catch (err) {
      console.error("[DataBridge] 拉取变量列表失败:", err);
      throw err;
    }
  }

  // ---- 底层 ----

  private sourceUnsubscribers: Map<string, () => void> = new Map();
  private snapshotReceived = false;

  private connectSource(name: string): void {
    const source = this.sources.get(name);
    if (!source) return;

    // 清理旧的订阅，避免回调重复触发
    const oldUnsub = this.sourceUnsubscribers.get(name);
    if (oldUnsub) oldUnsub();
    this.sourceUnsubscribers.delete(name);

    this.snapshotReceived = false;

    const unsub = source.subscribe({
      onData: (point) => {
        // 将后端点 ID 转换为内部变量 ID
        const varId = this.pointIdToVarId.get(String(point.id)) ?? point.id;
        const mapping = this.pointIdToVarId.get(String(point.id));
        console.log("[DataBridge] Data point:", point.id, "val:", point.value, "mapped to:", varId, "hasMapping:", !!mapping);
        this.variableManager.setValue(varId, point.value, point.quality);
      },
      onStatus: (status) => {
        if (status === "connected") {
          this.snapshotReceived = false; // Reset for new connection
        }
        this.notifyStatus(name, status);
      },
      onError: (err) => {
        console.warn("[DataBridge] " + name + ":", err.message);
      },
    });
    this.sourceUnsubscribers.set(name, unsub);

    source.connect().catch((err) => {
      console.error("[DataBridge] 连接失败 " + name + ":", err.message);
    });
  }

  /** 监听 WebSocket 的 config_change 事件，自动刷新变量列表 */
  private setupConfigChangeWatcher(): void {
    this.configChangeUnsub = this.wsClient.onConfigChange((event) => {
      console.log("[DataBridge] Config change detected:", event.action, event.variableId);
      // 防抖：2 秒内的多次变更合并为一次刷新
      if (this.configRefreshTimer) {
        clearTimeout(this.configRefreshTimer);
      }
      this.configRefreshTimer = setTimeout(async () => {
        console.log("[DataBridge] Auto-refreshing variables from backend...");
        try {
          await this.fetchVariablesFromBackend();
          this.onVarsRefreshed?.();
        } catch (err) {
          console.warn("[DataBridge] Auto-refresh failed:", err);
        }
      }, 2000);
    });
  }

  private disconnectAll(): void {
    for (const source of this.sources.values()) {
      source.disconnect();
    }
  }

  private getActiveDataSource(): DataSource | undefined {
    if (this.activeSource === "iec104") return this.iec104Simulator;
    if (this.activeSource === "websocket" || this.activeSource === "io_backend") return this.wsClient;
    return undefined;
  }

  private notifyStatus(source: string, status: ConnectionStatus): void {
    for (const cb of this.statusListeners) cb(source, status);
  }
}
