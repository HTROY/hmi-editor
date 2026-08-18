import { DataSource } from "./DataSource";
import type { DataSourceConfig } from "./types";

// ============================================================
// IEC104Simulator — IEC 60870-5-104 协议数据模拟器
// 模拟地铁综合监控系统 IEC 104 主站接收到的实时数据
// ============================================================

interface IEC104Point {
  address: number; // IOA (Information Object Address)
  type: "DI" | "AI" | "DO" | "AO";
  variableId: string; // 对应的变量 ID
  min?: number;
  max?: number;
  /** 模拟生成函数 */
  generator: () => number;
}

/** 地铁 ISCS 典型数据点模板 */
function createMetroPoints(): IEC104Point[] {
  // 辅助：正弦波发生器
  const sineWave = (center: number, amp: number, period: number) => {
    const phase = Math.random() * Math.PI * 2;
    return () =>
      center + amp * Math.sin((Date.now() / period + phase) * Math.PI * 2);
  };

  // 辅助：随机跳变（DI）
  const randomDI = (probOn = 0.5) => {
    let lastVal = Math.random() < probOn ? 1 : 0;
    let lastSwitch = Date.now();
    return () => {
      if (Date.now() - lastSwitch > 2000 + Math.random() * 5000) {
        lastVal = lastVal ? 0 : 1;
        lastSwitch = Date.now();
      }
      return lastVal;
    };
  };

  return [
    // ---- 车站1 供电系统 ----
    {
      address: 1001,
      type: "DI",
      variableId: "STA1_211_ACB_STATUS",
      generator: randomDI(0.7),
    },
    {
      address: 1002,
      type: "DI",
      variableId: "STA1_212_ACB_STATUS",
      generator: randomDI(0.6),
    },
    {
      address: 1003,
      type: "AI",
      variableId: "STA1_211_IA",
      min: 0,
      max: 2000,
      generator: sineWave(800, 400, 8),
    },
    {
      address: 1004,
      type: "AI",
      variableId: "STA1_211_IB",
      min: 0,
      max: 2000,
      generator: sineWave(780, 380, 8.5),
    },
    {
      address: 1005,
      type: "AI",
      variableId: "STA1_BUS_VOLTAGE",
      min: 0,
      max: 500,
      generator: sineWave(400, 15, 30),
    },
    {
      address: 1006,
      type: "DI",
      variableId: "STA1_211_ACB_CTRL",
      generator: randomDI(0.5),
    },

    // ---- 车站2 供电 ----
    {
      address: 2001,
      type: "DI",
      variableId: "STA2_221_ACB_STATUS",
      generator: randomDI(0.8),
    },
    {
      address: 2002,
      type: "AI",
      variableId: "STA2_221_IA",
      min: 0,
      max: 2000,
      generator: sineWave(600, 300, 7),
    },
    {
      address: 2003,
      type: "AI",
      variableId: "STA2_BUS_VOLTAGE",
      min: 0,
      max: 500,
      generator: sineWave(395, 20, 25),
    },

    // ---- BAS 环境控制 ----
    {
      address: 3001,
      type: "DI",
      variableId: "STA1_FAN_1_STATUS",
      generator: randomDI(0.9),
    },
    {
      address: 3002,
      type: "AI",
      variableId: "STA1_FAN_1_SPEED",
      min: 0,
      max: 3000,
      generator: sineWave(2400, 600, 12),
    },
    {
      address: 3003,
      type: "AI",
      variableId: "STA1_TEMP_ZONE1",
      min: 0,
      max: 50,
      generator: sineWave(26, 3, 60),
    },
    {
      address: 3004,
      type: "AI",
      variableId: "STA1_TEMP_ZONE2",
      min: 0,
      max: 50,
      generator: sineWave(24, 2, 55),
    },
    {
      address: 3005,
      type: "DI",
      variableId: "STA1_FAN_2_STATUS",
      generator: randomDI(0.3),
    },

    // ---- 信号系统 ----
    {
      address: 4001,
      type: "DI",
      variableId: "SIG_TRAIN_1_OCCUPY",
      generator: randomDI(0.2),
    },
    {
      address: 4002,
      type: "DI",
      variableId: "SIG_TRAIN_2_OCCUPY",
      generator: randomDI(0.15),
    },
    {
      address: 4003,
      type: "AI",
      variableId: "SIG_TRACK_VOLTAGE",
      min: 0,
      max: 100,
      generator: sineWave(90, 10, 40),
    },

    // ---- FAS 消防 ----
    {
      address: 5001,
      type: "DI",
      variableId: "FAS_SMOKE_DETECT_1",
      generator: () => 0,
    },
    {
      address: 5002,
      type: "DI",
      variableId: "FAS_FIRE_ALARM",
      generator: () => 0,
    },
    {
      address: 5003,
      type: "AI",
      variableId: "FAS_TEMP_ZONE3",
      min: 0,
      max: 100,
      generator: sineWave(28, 2, 50),
    },
  ];
}

export class IEC104Simulator extends DataSource {
  private points: IEC104Point[] = [];
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private scanInterval = 800; // 800ms 扫描周期（IEC 104 典型值）

  // 连接模拟参数
  private simulatedLatency = 50; // ms
  private simulatedPacketLoss = 0; // 0-1

  constructor(config: Partial<DataSourceConfig> = {}) {
    super({
      type: "iec104",
      name: config.name ?? "IEC 104 模拟器",
      enabled: true,
    });
  }

  setPoints(points: IEC104Point[]): void {
    this.points = points;
  }

  async connect(): Promise<void> {
    this.emitStatus("connecting");

    // 模拟连接建立延迟
    await new Promise((r) => setTimeout(r, this.simulatedLatency * 2));

    if (this.points.length === 0) {
      this.points = createMetroPoints();
    }

    this.emitStatus("connected");

    // 启动周期性扫描
    this.startScan();
  }

  disconnect(): void {
    this.stopScan();
    this.emitStatus("disconnected");
  }

  send(command: string, value?: unknown): void {
    // IEC 104 控制命令 (C_SC_NA_1 / C_SE_NA_1)
    const point = this.points.find((p) => p.variableId === command);
    if (point) {
      this.emitData({
        id: point.variableId,
        value: typeof value === "number" ? value : 0,
        quality: "good",
        timestamp: Date.now(),
      });
    }
  }

  /** 设置扫描周期（毫秒） */
  setScanInterval(ms: number): void {
    this.scanInterval = ms;
    if (this.isConnected) {
      this.stopScan();
      this.startScan();
    }
  }

  /** 模拟网络延迟 */
  setLatency(ms: number): void {
    this.simulatedLatency = ms;
  }

  /** 模拟丢包率 0-1 */
  setPacketLoss(rate: number): void {
    this.simulatedPacketLoss = Math.max(0, Math.min(1, rate));
  }

  // ---- 内部 ----

  private startScan(): void {
    if (this.scanTimer) return;
    this.scanTimer = setInterval(() => {
      this.scanPoints();
    }, this.scanInterval);
  }

  private stopScan(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  private scanPoints(): void {
    for (const point of this.points) {
      // 模拟丢包
      if (Math.random() < this.simulatedPacketLoss) continue;

      const rawValue = point.generator();
      const value =
        point.type === "DI" || point.type === "DO"
          ? rawValue
            ? 1
            : 0
          : Math.round(rawValue * 100) / 100;

      // 模拟延迟发送
      if (this.simulatedLatency > 0 && Math.random() < 0.3) {
        const delay = Math.random() * this.simulatedLatency;
        setTimeout(() => {
          this.emitData({
            id: point.variableId,
            value,
            quality: "good",
            timestamp: Date.now(),
          });
        }, delay);
      } else {
        this.emitData({
          id: point.variableId,
          value,
          quality: "good",
          timestamp: Date.now(),
        });
      }
    }
  }
}
