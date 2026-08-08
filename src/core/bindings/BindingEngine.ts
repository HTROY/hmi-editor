import { SceneGraph } from "../scene/SceneGraph";
import { Renderer } from "../scene/Renderer";
import { VariableManager } from "../variables/VariableManager";
import { ShapeBase } from "../shapes/ShapeBase";
import type { Binding } from "../types";
import { applyValueMapping } from "./mapping";

// ============================================================
// BindingEngine — 绑定引擎
// 监听变量变化 → 查绑定索引 → 执行值映射 → 更新图元属性 → 重绘
// 数值型属性默认 300ms ease-out 平滑过渡，每条绑定可单独关闭。
// ============================================================

interface BindingRecord {
  shapeId: string;
  binding: Binding;
}

interface Transition {
  from: number;
  to: number;
  start: number; // 毫秒时间戳
  duration: number; // 毫秒
}

const DEFAULT_SMOOTH_MS = 300;

export class BindingEngine {
  private scene: SceneGraph;
  private variables: VariableManager;
  private renderer: Renderer | null = null;

  // 反向索引: variableId → 绑定了该变量的图元列表
  private index: Map<string, BindingRecord[]> = new Map();

  private unsubAll: (() => void) | null = null;

  // 平滑过渡表：key = shapeId + "\u0000" + prop
  private transitions: Map<string, Transition> = new Map();
  private rafId: number | null = null;
  private now: () => number;

  constructor(
    scene: SceneGraph,
    variables: VariableManager,
    now: () => number = () => performance.now()
  ) {
    this.scene = scene;
    this.variables = variables;
    this.now = now;
  }

  setRenderer(r: Renderer): void {
    this.renderer = r;
  }

  /** 重建索引 — 遍历场景中所有图元的 bindings */
  rebuildIndex(): void {
    this.index.clear();
    for (const shape of this.scene.getAll()) {
      this.indexShape(shape);
    }
  }

  /** 为单个图元建立绑定索引 */
  private indexShape(shape: ShapeBase): void {
    for (const binding of shape.bindings) {
      if (!this.index.has(binding.variableId)) {
        this.index.set(binding.variableId, []);
      }
      this.index.get(binding.variableId)!.push({
        shapeId: shape.id,
        binding,
      });
    }
  }

  /** 为指定图元刷新索引（用于属性面板编辑绑定后调用） */
  reindexShape(shapeId: string): void {
    // 从索引中移除该图元的所有记录
    for (const [, records] of this.index) {
      const filtered = records.filter((r) => r.shapeId !== shapeId);
      if (filtered.length === 0) {
        this.index.delete(records[0]?.binding.variableId ?? "");
      } else {
        // 不能直接修改 records，需要重建数组
        records.length = 0;
        records.push(...filtered);
      }
    }
    // 重新添加
    const shape = this.scene.get(shapeId);
    if (shape) {
      this.indexShape(shape);
      // 立即用变量当前值刷新该图元的绑定属性，无需等待变量再次变化
      for (const binding of shape.bindings) {
        const vv = this.variables.getValue(binding.variableId);
        if (!vv) continue;
        this.applyBinding(shape, binding, vv.value);
      }
      this.renderer?.render();
    }
  }

  /** 启动监听 — 订阅变量变化并自动更新图元 */
  start(): void {
    // 先建索引
    this.rebuildIndex();
    // 订阅所有变量变化
    this.unsubAll = this.variables.subscribeAll((variableId, vv) => {
      const records = this.index.get(variableId);
      if (!records) return;

      for (const record of records) {
        const shape = this.scene.get(record.shapeId);
        if (!shape) continue;
        this.applyBinding(shape, record.binding, vv.value);
      }

      // 通知渲染器重绘
      this.renderer?.render();
    });
  }

  /** 停止监听 */
  stop(): void {
    this.unsubAll?.();
    this.unsubAll = null;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.transitions.clear();
  }

  // ============================================================
  // 值映射 + 平滑过渡
  // ============================================================

  private applyBinding(
    shape: ShapeBase,
    binding: Binding,
    rawValue: number | boolean
  ): void {
    const newValue = applyValueMapping(binding.mapping, rawValue);
    const current = (shape as any)[binding.targetProp];
    const smooth = binding.smooth !== false;

    if (smooth && typeof current === "number" && typeof newValue === "number") {
      this.startTransition(
        shape.id,
        binding.targetProp,
        current,
        newValue,
        binding.smoothMs ?? DEFAULT_SMOOTH_MS
      );
      return;
    }

    this.cancelTransition(shape.id, binding.targetProp);
    if (newValue !== undefined) {
      (shape as any)[binding.targetProp] = newValue;
    }
  }

  private startTransition(
    shapeId: string,
    prop: string,
    from: number,
    to: number,
    duration: number
  ): void {
    if (from === to) {
      this.cancelTransition(shapeId, prop);
      return;
    }
    this.transitions.set(this.key(shapeId, prop), {
      from,
      to,
      start: this.now(),
      duration: Math.max(1, duration),
    });
    this.ensureLoop();
  }

  private cancelTransition(shapeId: string, prop: string): void {
    this.transitions.delete(this.key(shapeId, prop));
  }

  private key(shapeId: string, prop: string): string {
    return shapeId + "\u0000" + prop;
  }

  private ensureLoop(): void {
    if (this.rafId !== null) return;
    if (typeof requestAnimationFrame !== "function") return;
    this.rafId = requestAnimationFrame(this.loop);
  }

  private loop = (): void => {
    this.rafId = null;
    if (this.transitions.size === 0) return;
    this.tick(this.now());
    if (this.transitions.size > 0) {
      this.rafId = requestAnimationFrame(this.loop);
    }
  };

  /** 推进全部平滑过渡（测试可传入固定时间戳） */
  tick(now: number): void {
    if (this.transitions.size === 0) return;
    const changed = new Set<string>();

    for (const [key, tr] of this.transitions) {
      const sep = key.indexOf("\u0000");
      const shapeId = key.slice(0, sep);
      const prop = key.slice(sep + 1);
      const progress = Math.min(1, (now - tr.start) / tr.duration);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      const value = tr.from + (tr.to - tr.from) * eased;
      const shape = this.scene.get(shapeId);
      if (shape) {
        (shape as any)[prop] = progress >= 1 ? tr.to : value;
        changed.add(shapeId);
      }
      if (progress >= 1) this.transitions.delete(key);
    }

    if (changed.size > 0) this.renderer?.render();
  }

  /** 手动触发一个变量更新（用于模拟/测试） */
  trigger(variableId: string, value: number | boolean): void {
    this.variables.setValue(variableId, value);
  }
}
