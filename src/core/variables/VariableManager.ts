import type {
  VariableDef,
  VariableValue,
  VariableType,
  VariableChangeCallback,
} from "./types";

// ============================================================
// VariableManager — 变量/点表管理器
//   - 管理所有变量定义（点表）
//   - 管理变量运行时值
//   - 支持订阅变量变化事件
//   - 支持模拟数据生成
// ============================================================

export class VariableManager {
  private defs: Map<string, VariableDef> = new Map();
  private values: Map<string, VariableValue> = new Map();
  private listeners: Map<string, Set<VariableChangeCallback>> = new Map();
  private globalListeners: Set<VariableChangeCallback> = new Set();

  // ---- 变量定义管理 ----

  /** 添加/更新变量定义 */
  define(def: VariableDef): void {
    this.defs.set(def.id, def);
    // 初始化运行时值
    if (!this.values.has(def.id)) {
      this.values.set(def.id, {
        id: def.id,
        value: def.defaultValue ?? 0,
        quality: "good",
        timestamp: Date.now(),
      });
    }
  }

  /** 批量定义 */
  defineMany(defs: VariableDef[]): void {
    for (const d of defs) this.define(d);
  }

  /** 删除变量定义 */
  remove(id: string): void {
    this.defs.delete(id);
    this.values.delete(id);
    this.listeners.delete(id);
  }

  /** 获取变量定义 */
  getDef(id: string): VariableDef | undefined {
    return this.defs.get(id);
  }

  /** 获取所有变量定义 */
  getAllDefs(): VariableDef[] {
    return Array.from(this.defs.values());
  }

  /** 按分组获取 */
  getDefsByGroup(group: string): VariableDef[] {
    return this.getAllDefs().filter((d) => d.group === group);
  }

  /** 按类型获取 */
  getDefsByType(type: VariableType): VariableDef[] {
    return this.getAllDefs().filter((d) => d.type === type);
  }

  // ---- 运行时值管理 ----

  /** 设置变量值（核心方法 — 触发通知） */
  setValue(
    id: string,
    value: number | boolean,
    quality: VariableValue["quality"] = "good",
  ): void {
    const def = this.defs.get(id);
    if (!def) return;

    // 数值类型转换
    let normalizedValue = value;
    if (def.type === "DI" || def.type === "DO") {
      normalizedValue = value ? 1 : 0;
    }

    const vv: VariableValue = {
      id,
      value: normalizedValue,
      quality,
      timestamp: Date.now(),
    };
    this.values.set(id, vv);

    // 通知订阅者
    this.notify(id, vv);
  }

  /** 批量设置（高效 — 一次性通知所有变更） */
  setValues(
    updates: {
      id: string;
      value: number | boolean;
      quality?: VariableValue["quality"];
    }[],
  ): void {
    const notified = new Set<string>();
    for (const u of updates) {
      const def = this.defs.get(u.id);
      if (!def) continue;
      const normalizedValue =
        def.type === "DI" || def.type === "DO" ? (u.value ? 1 : 0) : u.value;
      const vv: VariableValue = {
        id: u.id,
        value: normalizedValue,
        quality: u.quality ?? "good",
        timestamp: Date.now(),
      };
      this.values.set(u.id, vv);
      notified.add(u.id);
    }
    // 统一通知
    for (const id of notified) {
      this.notify(id, this.values.get(id)!);
    }
  }

  /** 获取变量运行时值 */
  getValue(id: string): VariableValue | undefined {
    return this.values.get(id);
  }

  /** 获取所有运行时值 */
  getAllValues(): VariableValue[] {
    return Array.from(this.values.values());
  }

  // ---- 订阅机制 ----

  /** 订阅单个变量变化 */
  subscribe(variableId: string, callback: VariableChangeCallback): () => void {
    if (!this.listeners.has(variableId)) {
      this.listeners.set(variableId, new Set());
    }
    this.listeners.get(variableId)!.add(callback);
    return () => this.listeners.get(variableId)?.delete(callback);
  }

  /** 订阅所有变量变化 */
  subscribeAll(callback: VariableChangeCallback): () => void {
    this.globalListeners.add(callback);
    return () => this.globalListeners.delete(callback);
  }

  private notify(id: string, vv: VariableValue): void {
    this.listeners.get(id)?.forEach((cb) => cb(id, vv));
    this.globalListeners.forEach((cb) => cb(id, vv));
  }

  // ---- 模拟数据 ----

  private simTimer: ReturnType<typeof setInterval> | null = null;

  /** 启动模拟数据（DI 随机跳变，AI 正弦波） */
  startSimulation(intervalMs = 1000): void {
    if (this.simTimer) return;
    this.simTimer = setInterval(() => {
      const updates: { id: string; value: number | boolean }[] = [];
      for (const def of this.defs.values()) {
        if (def.type === "DI" || def.type === "DO") {
          updates.push({ id: def.id, value: Math.random() > 0.5 ? 1 : 0 });
        } else {
          const current = this.values.get(def.id)?.value ?? def.defaultValue;
          const delta = (Math.random() - 0.5) * (def.max - def.min) * 0.1;
          const newVal = Math.max(
            def.min,
            Math.min(def.max, (current as number) + delta),
          );
          updates.push({ id: def.id, value: Math.round(newVal * 100) / 100 });
        }
      }
      this.setValues(updates);
    }, intervalMs);
  }

  stopSimulation(): void {
    if (this.simTimer) {
      clearInterval(this.simTimer);
      this.simTimer = null;
    }
  }

  get isSimulating(): boolean {
    return this.simTimer !== null;
  }

  // ---- 工具 ----

  /** 替换所有变量定义（清除旧数据并批量导入） */
  replaceAll(defs: VariableDef[]): void {
    this.stopSimulation();
    this.defs.clear();
    this.values.clear();
    this.listeners.clear();
    for (const d of defs) this.define(d);
  }

  clear(): void {
    this.stopSimulation();
    this.defs.clear();
    this.values.clear();
    this.listeners.clear();
  }

  /** 获取变量数量 */
  get count(): number {
    return this.defs.size;
  }
}
