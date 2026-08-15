import { SceneGraph } from "../scene/SceneGraph";
import { Renderer } from "../scene/Renderer";
import { VariableManager } from "../variables/VariableManager";
import { ShapeBase } from "../shapes/ShapeBase";
import { capabilityOf } from "../shapes/capability";
import { GroupShape } from "../shapes/GroupShape";
import type { Binding } from "../types";
import { applyValueMapping } from "./mapping";
import { forEachShape, resolveShape, type ShapePath } from "../inspector/tree";
import { createLogger } from "../platform/logger";

// ============================================================
// BindingEngine — 绑定引擎
// 监听变量变化 → 查绑定索引 → 执行值映射 → 更新图元属性 → 重绘
// 数值型属性默认 300ms ease-out 平滑过渡，每条绑定可单独关闭。
// ============================================================

interface BindingRecord {
  /** 图元从场景根开始的完整路径（含自身 id） */
  path: ShapePath;
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
  private readonly logger = createLogger("BindingEngine");

  // 反向索引: variableId → 绑定了该变量的图元列表
  private index: Map<string, BindingRecord[]> = new Map();

  private unsubAll: (() => void) | null = null;

  // 平滑过渡表：key = shapeId + "\u0000" + prop
  private transitions: Map<string, Transition> = new Map();
  private rafId: number | null = null;
  private now: () => number;
  /** 已告警过的未注册绑定目标（防刷屏） */
  private warnedProps = new Set<string>();

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
    forEachShape(this.scene, (shape, path) => this.indexShape(shape, path));
  }

  /** 为单个图元建立绑定索引 */
  private indexShape(shape: ShapeBase, path: ShapePath): void {
    for (const binding of shape.bindings) {
      if (!this.index.has(binding.variableId)) {
        this.index.set(binding.variableId, []);
      }
      this.index.get(binding.variableId)!.push({
        path,
        binding,
      });
    }
  }

  /** 为指定图元刷新索引（用于属性面板编辑绑定后调用） */
  reindexShape(shapeId: string): void {
    this.reindexPath([shapeId]);
  }

  /** 按完整路径刷新索引（顶层或组内子图元均可），并立即应用变量当前值 */
  reindexPath(path: ShapePath): void {
    this.removeRecords((p) => path.every((id, i) => p[i] === id));
    const shape = resolveShape(this.scene, path);
    if (!shape) return;
    this.indexSubtree(shape, path);
    this.applyCurrentValues(shape, path);
    this.renderer?.render();
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
        const shape = resolveShape(this.scene, record.path);
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
    const bp = capabilityOf(shape).bindableProps?.[binding.targetProp];
    if (!bp) {
      this.warnUnregistered(shape, binding.targetProp);
      return;
    }
    const current = bp.get(shape);
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
      bp.set(shape, newValue);
    }
  }

  /** 绑定目标属性未在能力注册表登记：一次性告警并忽略写入（typo 不再静默 no-op） */
  private warnUnregistered(shape: ShapeBase, prop: string): void {
    const key = shape.type + ":" + prop;
    if (this.warnedProps.has(key)) return;
    this.warnedProps.add(key);
    this.logger.warn("绑定目标属性未在能力注册表登记，忽略写入:", key);
  }

  private removeRecords(pred: (path: ShapePath) => boolean): void {
    for (const [variableId, records] of this.index) {
      const filtered = records.filter((r) => !pred(r.path));
      if (filtered.length === 0) {
        this.index.delete(variableId);
      } else {
        records.length = 0;
        records.push(...filtered);
      }
    }
  }

  private indexSubtree(shape: ShapeBase, path: ShapePath): void {
    this.indexShape(shape, path);
    if (shape instanceof GroupShape) {
      for (const child of shape.children) {
        this.indexSubtree(child, [...path, child.id]);
      }
    }
  }

  private applyCurrentValues(shape: ShapeBase, path: ShapePath): void {
    for (const binding of shape.bindings) {
      const vv = this.variables.getValue(binding.variableId);
      if (!vv) continue;
      this.applyBinding(shape, binding, vv.value);
    }
    if (shape instanceof GroupShape) {
      for (const child of shape.children) {
        this.applyCurrentValues(child, [...path, child.id]);
      }
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
        const bp = capabilityOf(shape).bindableProps?.[prop];
        if (bp) {
          bp.set(shape, progress >= 1 ? tr.to : value);
          changed.add(shapeId);
        }
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
