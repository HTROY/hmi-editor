import { SceneGraph } from "./SceneGraph";
import { ShapeBase } from "../shapes/ShapeBase";

// ============================================================
// Renderer — Canvas 渲染器
// 负责全图重绘和增量脏矩形重绘
// ============================================================

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scene: SceneGraph;

  // 选中的图元 ID 集合
  selectedIds: Set<string> = new Set();

  constructor(canvas: HTMLCanvasElement, scene: SceneGraph) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.scene = scene;
  }

  /** 全图重绘 */
  render(): void {
    const ctx = this.ctx;
    const { width, height } = this.canvas;

    // 清空
    ctx.clearRect(0, 0, width, height);

    // 绘制网格背景
    this.drawGrid(ctx, width, height);

    // 绘制所有图元
    const shapes = this.scene.getAll();
    for (const shape of shapes) {
      shape.render(ctx);
    }

    // 绘制选中状态（包围框 + 手柄）
    for (const shape of shapes) {
      if (this.selectedIds.has(shape.id)) {
        this.drawSelection(shape);
      }
    }
  }

  /** 绘制网格 */
  private drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    ctx.save();
    ctx.strokeStyle = "#E8E8E8";
    ctx.lineWidth = 0.2;
    const gridSize = 20;
    for (let x = 0; x < w; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = 0; y < h; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 绘制选中边框 */
  private drawSelection(shape: ShapeBase): void {
    const ctx = this.ctx;
    const bb = shape.boundingBox;
    ctx.save();

    // 蓝色选中边框
    ctx.strokeStyle = "#1890FF";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(bb.x - 2, bb.y - 2, bb.width + 4, bb.height + 4);

    // 重置虚线
    ctx.setLineDash([]);

    // 八个控制手柄
    const handleSize = 6;
    const handles = [
      { x: bb.x, y: bb.y },
      { x: bb.x + bb.width / 2, y: bb.y },
      { x: bb.x + bb.width, y: bb.y },
      { x: bb.x + bb.width, y: bb.y + bb.height / 2 },
      { x: bb.x + bb.width, y: bb.y + bb.height },
      { x: bb.x + bb.width / 2, y: bb.y + bb.height },
      { x: bb.x, y: bb.y + bb.height },
      { x: bb.x, y: bb.y + bb.height / 2 },
    ];

    ctx.fillStyle = "#FFFFFF";
    ctx.strokeStyle = "#1890FF";
    ctx.lineWidth = 1.5;
    for (const h of handles) {
      ctx.fillRect(
        h.x - handleSize / 2,
        h.y - handleSize / 2,
        handleSize,
        handleSize,
      );
      ctx.strokeRect(
        h.x - handleSize / 2,
        h.y - handleSize / 2,
        handleSize,
        handleSize,
      );
    }

    ctx.restore();
  }

  /** 调整画布尺寸 */
  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
    this.render();
  }
}
