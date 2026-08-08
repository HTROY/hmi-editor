import { SceneGraph } from "../scene/SceneGraph";
import { Renderer } from "../scene/Renderer";
import { VariableManager } from "../variables/VariableManager";
import { MetroFan } from "../shapes/metro/MetroFan";
import {
  computeAnimationFrame,
  mergeAnimationFrames,
  resolveAnimationControl,
  type AnimationFrameState,
} from "./animation";

// ============================================================
// AnimationEngine — 通用动画引擎
// 逐帧遍历图元的 animations 数组，五类动画（闪烁/旋转/位移/
// 缩放/变色）叠加成帧状态交给 Renderer 绘制；
// 可选绑定变量经值映射控制速度/强度/启停。
// 只在模拟或单页预览时启动，编辑时静态。
// ============================================================

export class AnimationEngine {
  private scene: SceneGraph;
  private variables: VariableManager;
  private renderer: Renderer | null = null;
  private running = false;
  private lastTime = 0;
  private rafId: number | null = null;
  private phases = new Map<string, number>();
  private state = new Map<string, AnimationFrameState>();

  constructor(scene: SceneGraph, variables: VariableManager) {
    this.scene = scene;
    this.variables = variables;
  }

  setRenderer(r: Renderer): void {
    this.renderer = r;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.loop(this.lastTime);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.phases.clear();
    // 停止后清掉帧状态，让图元回到静态
    if (this.state.size > 0) {
      this.state.clear();
      this.renderer?.setAnimationState(new Map());
      this.renderer?.render();
    }
  }

  private loop = (timestamp: number): void => {
    if (!this.running) return;

    const deltaMs = timestamp - this.lastTime;
    this.lastTime = timestamp;
    this.update(deltaMs);

    this.rafId = requestAnimationFrame(this.loop);
  };

  /** 推进一帧（测试可手动调用；不要求 RAF 已启动） */
  update(deltaMs: number): void {
    if (deltaMs <= 0) return;
    const nextState = new Map<string, AnimationFrameState>();
    const changed = new Set<string>();

    for (const shape of this.scene.getAll()) {
      let merged: AnimationFrameState | null = null;

      // 保留 MetroFan 自带的叶片旋转驱动
      if (shape instanceof MetroFan && shape.running) {
        shape.updateAnimation(deltaMs);
        merged = merged ?? {};
        changed.add(shape.id);
      }

      for (const anim of shape.animations) {
        const runtime = resolveAnimationControl(anim, (variableId) =>
          this.variables.getValue(variableId)
        );
        if (!runtime.enabled) continue;

        const key = shape.id + ":" + anim.id;
        const phase =
          (this.phases.get(key) ?? 0) + (deltaMs / 1000) * runtime.speedMul;
        this.phases.set(key, phase);

        const frame = computeAnimationFrame(anim, phase, runtime);
        merged = mergeAnimationFrames(merged, frame);
        changed.add(shape.id);
      }

      if (merged) nextState.set(shape.id, merged);
    }

    this.state = nextState;
    if (changed.size > 0) {
      this.renderer?.setAnimationState(nextState);
      this.renderer?.render();
    }
  }

  get isRunning(): boolean {
    return this.running;
  }
}
