import { SceneGraph } from "../scene/SceneGraph";
import { Renderer } from "../scene/Renderer";
import { VariableManager } from "../variables/VariableManager";
import { ShapeBase } from "../shapes/ShapeBase";
import type { Binding, ValueMapping } from "../types";

// ============================================================
// BindingEngine — 绑定引擎
// 监听变量变化 → 查绑定索引 → 执行值映射 → 更新图元属性 → 重绘
// ============================================================

interface BindingRecord {
  shapeId: string;
  binding: Binding;
}

export class BindingEngine {
  private scene: SceneGraph;
  private variables: VariableManager;
  private renderer: Renderer | null = null;

  // 反向索引: variableId → 绑定了该变量的图元列表
  private index: Map<string, BindingRecord[]> = new Map();

  private unsubAll: (() => void) | null = null;

  constructor(scene: SceneGraph, variables: VariableManager) {
    this.scene = scene;
    this.variables = variables;
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
    if (shape) this.indexShape(shape);
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

        const newValue = this.applyMapping(record.binding, vv.value);
        if (newValue !== undefined) {
          (shape as any)[record.binding.targetProp] = newValue;
        }
      }

      // 通知渲染器重绘
      this.renderer?.render();
    });
  }

  /** 停止监听 */
  stop(): void {
    this.unsubAll?.();
    this.unsubAll = null;
  }

  // ============================================================
  // 值映射引擎（核心）
  // ============================================================

  private applyMapping(binding: Binding, rawValue: number | boolean): any {
    const mapping = binding.mapping;
    switch (mapping.type) {
      case "direct":
        return rawValue;

      case "enum": {
        // DI 0/1 → 颜色字符串
        const key = String(rawValue);
        return mapping.map[key] ?? rawValue;
      }

      case "range": {
        if (typeof rawValue !== "number") return rawValue;
        // 将 rawValue 从 [from[0], from[1]] 线性映射到 [to[0], to[1]]
        const [fromMin, fromMax] = mapping.from;
        const [toMin, toMax] = mapping.to;
        if (fromMax === fromMin) return toMin;
        const ratio = (rawValue - fromMin) / (fromMax - fromMin);
        return Math.round((toMin + ratio * (toMax - toMin)) * 100) / 100;
      }

      case "stateColor": {
        // 数值直接作为颜色值使用 (0xFF0000 格式)
        if (typeof rawValue === "number") {
          return "#" + rawValue.toString(16).padStart(6, "0");
        }
        return rawValue ? "#00FF00" : "#808080";
      }

      case "bitmask":
        return this.applyBitmask(binding, rawValue);

      default:
        return rawValue;
    }
  }

  private applyBitmask(binding: Binding, rawValue: number | boolean): string[] {
    const mapping = binding.mapping as ValueMapping & { type: "bitmask" };
    if (typeof rawValue !== "number") return [];
    const activeStates: string[] = [];
    for (const bit of mapping.bits) {
      if (rawValue & Math.pow(2, bit)) {
        const state = mapping.states[Math.pow(2, bit)];
        if (state) activeStates.push(state);
      }
    }
    return activeStates;
  }

  /** 手动触发一个变量更新（用于模拟/测试） */
  trigger(variableId: string, value: number | boolean): void {
    this.variables.setValue(variableId, value);
  }
}
