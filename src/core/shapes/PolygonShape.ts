import { ShapeBase } from "./ShapeBase";
import { getPaint } from "./paint";
import type { ShapeProps, Point, BoundingBox } from "../types";

// ============================================================
// PolygonShape — 多边形（SVG polygon 导入产物）
// 点位为世界坐标（组内为相对组原点的坐标）
// ============================================================

export class PolygonShape extends ShapeBase {
  points: Point[];

  constructor(props?: Partial<ShapeProps>) {
    super("polygon", props);
    this.points = Array.isArray(props?.points)
      ? props!.points!.map((p) => ({ ...p }))
      : [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
        ];
  }

  get boundingBox(): BoundingBox {
    if (this.points.length === 0) return super.boundingBox;
    const xs = this.points.map((p) => p.x);
    const ys = this.points.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return {
      x: minX,
      y: minY,
      width: maxX - minX || 1,
      height: maxY - minY || 1,
    };
  }

  hitTest(point: Point): boolean {
    return this.hitTestLocalBox(point);
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible || this.points.length < 3) return;
    ctx.save();
    ctx.globalAlpha = this.opacity;

    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) {
      ctx.lineTo(this.points[i].x, this.points[i].y);
    }
    ctx.closePath();

    if (this.fill !== "transparent") {
      ctx.fillStyle = getPaint(ctx, this, "fill");
      ctx.fill();
    }
    ctx.strokeStyle = getPaint(ctx, this, "stroke");
    ctx.lineWidth = this.strokeWidth;
    if (this.dashArray.length > 0) ctx.setLineDash(this.dashArray);
    ctx.stroke();
    ctx.restore();
  }

  clone(): PolygonShape {
    return new PolygonShape(this.toJSON());
  }

  scale(sx: number, sy: number): void {
    super.scale(sx, sy);
    this.points = this.points.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  }

  toJSON(): ShapeProps {
    return {
      ...super.toJSON(),
      points: this.points.map((p) => ({ ...p })),
    };
  }
}
