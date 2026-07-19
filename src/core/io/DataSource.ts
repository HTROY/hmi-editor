import type {
  DataSourceConfig,
  DataSourceCallback,
  ConnectionStatus,
  DataPoint,
} from "./types";

// ============================================================
// DataSource — 数据源抽象基类
// 所有数据源（WebSocket / IEC104 / OPC UA）继承此类
// ============================================================

export abstract class DataSource {
  config: DataSourceConfig;
  protected status: ConnectionStatus = "disconnected";
  protected callbacks: DataSourceCallback[] = [];

  constructor(config: DataSourceConfig) {
    this.config = config;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): void;
  abstract send(command: string, value?: any): void;

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  get isConnected(): boolean {
    return this.status === "connected";
  }

  // ---- 回调管理 ----

  subscribe(cb: DataSourceCallback): () => void {
    this.callbacks.push(cb);
    return () => {
      this.callbacks = this.callbacks.filter((c) => c !== cb);
    };
  }

  protected emitData(point: DataPoint): void {
    for (const cb of this.callbacks) cb.onData(point);
  }

  protected emitStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const cb of this.callbacks) cb.onStatus(status);
  }

  protected emitError(error: Error): void {
    for (const cb of this.callbacks) cb.onError(error);
  }
}
