import { VariableManager } from "../variables/VariableManager";
import { Emitter } from "../platform/Emitter";
import type { HistoryPoint, TrendConfig } from "./types";

// ============================================================
// Historian — 历史数据记录器
// 周期性采样变量值，支持压缩存储和查询
// ============================================================

export class Historian {
  private data: HistoryPoint[] = [];
  private maxPoints = 50000;
  private sampleInterval = 2000; // 2秒采样
  private timer: ReturnType<typeof setInterval> | null = null;
  private varManager: VariableManager;
  private variableIds: string[] = [];

  private emitter = new Emitter<void>();

  constructor(varManager: VariableManager) {
    this.varManager = varManager;
  }

  onChange(cb: () => void): () => void {
    return this.emitter.onChange(cb);
  }

  private notify(): void {
    this.emitter.emit();
  }

  /** 设置要记录的变量列表 */
  setVariables(ids: string[]): void {
    this.variableIds = ids;
  }

  /** 添加变量 */
  addVariable(id: string): void {
    if (!this.variableIds.includes(id)) {
      this.variableIds.push(id);
    }
  }

  /** 设置采样间隔 */
  setSampleInterval(ms: number): void {
    this.sampleInterval = ms;
    if (this.timer) {
      this.stop();
      this.start();
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const now = Date.now();
      for (const id of this.variableIds) {
        const vv = this.varManager.getValue(id);
        if (vv && typeof vv.value === "number") {
          this.data.push({
            variableId: id,
            value: vv.value,
            timestamp: now,
          });
        }
      }
      // 限制缓冲区大小
      if (this.data.length > this.maxPoints) {
        this.data = this.data.slice(-this.maxPoints);
      }
      this.notify();
    }, this.sampleInterval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 查询历史数据 */
  query(
    variableId: string,
    from: number,
    to: number,
    maxPoints = 500
  ): HistoryPoint[] {
    let points = this.data.filter(
      (p) =>
        p.variableId === variableId && p.timestamp >= from && p.timestamp <= to
    );
    // 降采样
    if (points.length > maxPoints) {
      const step = Math.ceil(points.length / maxPoints);
      points = points.filter((_, i) => i % step === 0);
    }
    return points;
  }

  /** 获取所有已记录的变量 ID */
  getRecordedVariables(): string[] {
    return [...new Set(this.data.map((p) => p.variableId))];
  }

  /** 获取最新 N 条数据点 */
  getLatest(variableId: string, count = 100): HistoryPoint[] {
    return this.data.filter((p) => p.variableId === variableId).slice(-count);
  }

  /** 清空历史 */
  clear(): void {
    this.data = [];
    this.notify();
  }

  get totalPoints(): number {
    return this.data.length;
  }

  /** 获取趋势图配置建议（根据变量量程自动生成） */
  getTrendConfig(variableId: string): TrendConfig | null {
    const def = this.varManager.getDef(variableId);
    if (!def) return null;
    return {
      variableId,
      label: def.name || variableId,
      color: "#4A90D9",
      min: def.min ?? 0,
      max: def.max ?? 100,
      unit: def.unit || "",
    };
  }
}
