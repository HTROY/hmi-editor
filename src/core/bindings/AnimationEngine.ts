import { SceneGraph } from "../scene/SceneGraph";
import { Renderer } from "../scene/Renderer";
import { MetroFan } from "../shapes/metro/MetroFan";

// ============================================================
// AnimationEngine — 动画引擎
// 驱动 MetroFan 等图元的连续动画
// ============================================================

export class AnimationEngine {
  private scene: SceneGraph;
  private renderer: Renderer | null = null;
  private running = false;
  private lastTime = 0;
  private rafId: number | null = null;

  constructor(scene: SceneGraph) {
    this.scene = scene;
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
  }

  private loop = (timestamp: number): void => {
    if (!this.running) return;

    const deltaMs = timestamp - this.lastTime;
    this.lastTime = timestamp;

    // 驱动所有风机的旋转动画
    let needRender = false;
    for (const shape of this.scene.getAll()) {
      if (shape instanceof MetroFan && shape.running) {
        shape.updateAnimation(deltaMs);
        needRender = true;
      }
    }

    if (needRender) {
      this.renderer?.render();
    }

    this.rafId = requestAnimationFrame(this.loop);
  };

  get isRunning(): boolean {
    return this.running;
  }
}
