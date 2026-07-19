import { ShapeBase } from "./ShapeBase";
import type { ShapeProps, Point, BoundingBox } from "../types";

// ============================================================
// LineShape — 直线/折线
// ============================================================

export class LineShape extends ShapeBase {
  startPoint: Point;
  endPoint: Point;

  constructor(props?: Partial<ShapeProps>) {
    super("line", props);
    this.startPoint = props?.startPoint ?? { x: 0, y: 0 };
    this.endPoint = props?.endPoint ?? { x: 100, y: 100 };
    this.fill = "transparent";
  }

  get boundingBox(): BoundingBox {
    const minX = Math.min(this.startPoint.x, this.endPoint.x);
    const minY = Math.min(this.startPoint.y, this.endPoint.y);
    const maxX = Math.max(this.startPoint.x, this.endPoint.x);
    const maxY = Math.max(this.startPoint.y, this.endPoint.y);
    return {
      x: minX,
      y: minY,
      width: maxX - minX || 1,
      height: maxY - minY || 1,
    };
  }

  get center(): Point {
    return {
      x: (this.startPoint.x + this.endPoint.x) / 2,
      y: (this.startPoint.y + this.endPoint.y) / 2,
    };
  }

  hitTest(point: Point): boolean {
    // 点到线段的距离 < strokeWidth/2 + 4px 点击容差
    const { x: ax, y: ay } = this.startPoint;
    const { x: bx, y: by } = this.endPoint;
    const { x: px, y: py } = point;

    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;

    const ab2 = abx * abx + aby * aby;
    if (ab2 === 0) return Math.hypot(px - ax, py - ay) < 6;

    let t = (apx * abx + apy * aby) / ab2;
    t = Math.max(0, Math.min(1, t));

    const closestX = ax + t * abx;
    const closestY = ay + t * aby;
    const dist = Math.hypot(px - closestX, py - closestY);

    return dist < this.strokeWidth / 2 + 4;
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;
    ctx.save();
    ctx.globalAlpha = this.opacity;

    ctx.beginPath();
    ctx.moveTo(this.startPoint.x, this.startPoint.y);
    ctx.lineTo(this.endPoint.x, this.endPoint.y);

    ctx.strokeStyle = this.stroke;
    ctx.lineWidth = this.strokeWidth;
    if (this.dashArray.length > 0) ctx.setLineDash(this.dashArray);
    ctx.stroke();

    ctx.restore();
  }

  clone(): LineShape {
    const c = new LineShape(this.toJSON());
    c.startPoint = { ...this.startPoint };
    c.endPoint = { ...this.endPoint };
    return c;
  }

  toJSON(): ShapeProps {
    return {
      ...super.toJSON(),
      startPoint: { ...this.startPoint },
      endPoint: { ...this.endPoint },
    };
  }
}
