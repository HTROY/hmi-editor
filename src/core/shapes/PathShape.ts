import { ShapeBase } from "./ShapeBase";
import type { ShapeProps, Point } from "../types";

// ============================================================
// PathShape — 路径图元（SVG path 数据，矢量导入/编辑的基础）
// ============================================================

export class PathShape extends ShapeBase {
  d: string;

  constructor(props?: Partial<ShapeProps>) {
    super("path", props);
    this.d = props?.d ?? "M10 10 L90 10 L90 90 L10 90 Z";
  }

  hitTest(point: Point): boolean {
    // 先逆旋转到本地坐标系，再按包围盒粗判
    return this.hitTestLocalBox(point);
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;
    if (typeof Path2D === "undefined" || !this.d) return;

    ctx.save();
    ctx.translate(this.x + this.width / 2, this.y + this.height / 2);
    ctx.rotate(this.rotation * (Math.PI / 180));
    ctx.translate(-this.width / 2, -this.height / 2);
    ctx.globalAlpha = this.opacity;

    const path = new Path2D(this.d);
    ctx.fillStyle = this.fill;
    ctx.fill(path);
    ctx.strokeStyle = this.stroke;
    ctx.lineWidth = this.strokeWidth;
    if (this.dashArray.length > 0) ctx.setLineDash(this.dashArray);
    ctx.stroke(path);

    ctx.restore();
  }

  clone(): PathShape {
    return new PathShape(this.toJSON());
  }

  toJSON(): ShapeProps {
    return { ...super.toJSON(), d: this.d };
  }
}
