import { SceneGraph } from "./SceneGraph";
import { ShapeBase } from "../shapes/ShapeBase";
import { ImageShape } from "../shapes/ImageShape";
import { Viewport } from "../view";
import { getRotatedAABB } from "./resize";
import type { AnimationFrameState } from "../bindings/animation";

// ============================================================
// Renderer — Canvas 渲染器
// 负责按视图变换（缩放/平移）绘制页面边界、网格与全部图元
// ============================================================

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scene: SceneGraph;
  private viewport: Viewport | null = null;
  private pageWidth = 1920;
  private pageHeight = 1080;
  private pageBackground = "#FFFFFF";

  // 选中的图元 ID 集合
  selectedIds: Set<string> = new Set();
  private attachedImages = new WeakSet<ImageShape>();
  private animationState: Map<string, AnimationFrameState> = new Map();

  constructor(canvas: HTMLCanvasElement, scene: SceneGraph) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.scene = scene;
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  /** 绑定当前页面的视图变换（缩放/平移） */
  setViewport(viewport: Viewport | null): void {
    this.viewport = viewport;
  }

  /** 绑定当前页面的尺寸与背景色 */
  setPage(width: number, height: number, background: string): void {
    this.pageWidth = width;
    this.pageHeight = height;
    this.pageBackground = background;
  }

  /** 绑定动画引擎算出的逐图元帧状态（空 Map 表示静态） */
  setAnimationState(state: Map<string, AnimationFrameState>): void {
    this.animationState = state;
  }

  /** 全图重绘 */
  render(): void {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    const zoom = this.viewport?.zoom ?? 1;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);

    ctx.save();
    if (this.viewport) {
      ctx.translate(this.viewport.panX, this.viewport.panY);
      ctx.scale(zoom, zoom);
    }

    // 页面边界 + 留白 + 网格
    this.drawPage(ctx, zoom);
    this.drawGrid(ctx, this.pageWidth, this.pageHeight, zoom);

    // 绘制所有图元（世界坐标，视图变换不影响图元坐标）
    const shapes = this.scene.getAll();
    for (const shape of shapes) {
      this.renderShape(ctx, shape);
      if (shape instanceof ImageShape) this.attachImageReload(shape);
    }

    // 绘制选中状态（包围框 + 手柄），屏幕尺寸保持恒定
    for (const shape of shapes) {
      if (this.selectedIds.has(shape.id)) {
        this.drawSelection(shape, zoom);
      }
    }

    ctx.restore();
  }

  /** 绘制单个图元；有动画帧状态时先叠加位移/旋转/缩放/透明度/色相 */
  private renderShape(ctx: CanvasRenderingContext2D, shape: ShapeBase): void {
    const anim = this.animationState.get(shape.id);
    if (!anim) {
      shape.render(ctx);
      return;
    }

    const prevOpacity = shape.opacity;
    if (anim.opacity !== undefined) {
      shape.opacity = Math.min(1, Math.max(0, anim.opacity));
    }
    try {
      ctx.save();
      this.applyAnimationTransform(ctx, shape, anim);
      if (anim.hueRotate !== undefined && anim.hueRotate !== 0) {
        ctx.filter = "hue-rotate(" + anim.hueRotate + "deg)";
      }
      shape.render(ctx);
      ctx.restore();
    } finally {
      shape.opacity = prevOpacity;
    }
  }

  /** 以图元包围盒中心为基准叠加动画变换（不修改图元坐标） */
  private applyAnimationTransform(
    ctx: CanvasRenderingContext2D,
    shape: ShapeBase,
    anim: AnimationFrameState
  ): void {
    const cx = shape.x + shape.width / 2;
    const cy = shape.y + shape.height / 2;
    const dx = anim.dx ?? 0;
    const dy = anim.dy ?? 0;
    const rotation = anim.rotation ?? 0;
    const sx = anim.scaleX ?? 1;
    const sy = anim.scaleY ?? 1;
    if (dx === 0 && dy === 0 && rotation === 0 && sx === 1 && sy === 1) {
      return;
    }
    ctx.translate(cx + dx, cy + dy);
    ctx.rotate((rotation * Math.PI) / 180);
    ctx.scale(sx, sy);
    ctx.translate(-cx, -cy);
  }

  /** 图片加载完成后自动重绘 */
  private attachImageReload(shape: ImageShape): void {
    if (this.attachedImages.has(shape)) return;
    this.attachedImages.add(shape);
    shape.addLoadListener(() => this.render());
  }

  /** 绘制页面边界、背景与页眉标注 */
  private drawPage(ctx: CanvasRenderingContext2D, zoom: number): void {
    ctx.save();
    ctx.fillStyle = this.pageBackground;
    ctx.fillRect(0, 0, this.pageWidth, this.pageHeight);

    ctx.strokeStyle = "rgba(110, 130, 150, 0.85)";
    ctx.lineWidth = 1 / zoom;
    ctx.strokeRect(0, 0, this.pageWidth, this.pageHeight);

    ctx.fillStyle = "rgba(110, 130, 150, 0.7)";
    ctx.font = 12 / zoom + "px Consolas, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(this.pageWidth + " × " + this.pageHeight, 8 / zoom, 8 / zoom);
    ctx.restore();
  }

  /** 绘制页面内的网格（世界坐标，随视图缩放） */
  private drawGrid(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    zoom: number
  ): void {
    ctx.save();
    ctx.strokeStyle = "rgba(130, 145, 160, 0.24)";
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    const gridSize = 20;
    for (let x = 0; x <= w; x += gridSize) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = 0; y <= h; y += gridSize) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** 绘制选中边框（线宽与手柄大小按缩放换算，保证屏幕观感一致） */
  private drawSelection(shape: ShapeBase, zoom: number): void {
    const ctx = this.ctx;
    // 旋转图元按屏幕轴对齐外接框显示手柄
    const bb = getRotatedAABB(shape);
    ctx.save();

    // 蓝色选中边框
    ctx.strokeStyle = "#1890FF";
    ctx.lineWidth = 2 / zoom;
    ctx.setLineDash([4 / zoom, 4 / zoom]);
    ctx.strokeRect(
      bb.x - 2 / zoom,
      bb.y - 2 / zoom,
      bb.width + 4 / zoom,
      bb.height + 4 / zoom
    );

    // 重置虚线
    ctx.setLineDash([]);

    // 八个控制手柄
    const handleSize = 6 / zoom;
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
    ctx.lineWidth = 1.5 / zoom;
    for (const h of handles) {
      ctx.fillRect(
        h.x - handleSize / 2,
        h.y - handleSize / 2,
        handleSize,
        handleSize
      );
      ctx.strokeRect(
        h.x - handleSize / 2,
        h.y - handleSize / 2,
        handleSize,
        handleSize
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
