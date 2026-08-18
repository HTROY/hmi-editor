import { ShapeBase } from "./ShapeBase";
import type { ShapeProps, Point } from "../types";
import { getPaint } from "./paint";
import { baseBindableProps } from "./bindable";
import type { ShapeCapability } from "./capability";

// ============================================================
// CircleShape — 圆形/椭圆
// ============================================================

export class CircleShape extends ShapeBase {
  constructor(props?: Partial<ShapeProps>) {
    super("circle", props);
    this.width = props?.width ?? 80;
    this.height = props?.height ?? 80;
    // 保证宽高一致为正圆，但允许椭圆
  }

  hitTest(point: Point): boolean {
    // 逆旋转到本地坐标
    const dx = point.x - this.center.x;
    const dy = point.y - this.center.y;
    const rad = -this.rotation * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;

    const rx = this.width / 2;
    const ry = this.height / 2;
    if (rx <= 0 || ry <= 0) return false;

    return (localX * localX) / (rx * rx) + (localY * localY) / (ry * ry) <= 1;
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;
    ctx.save();
    ctx.translate(this.center.x, this.center.y);
    ctx.rotate(this.rotation * (Math.PI / 180));
    ctx.globalAlpha = this.opacity;

    ctx.beginPath();
    ctx.ellipse(0, 0, this.width / 2, this.height / 2, 0, 0, Math.PI * 2);

    ctx.fillStyle = getPaint(ctx, this, "fill");
    ctx.fill();
    ctx.strokeStyle = getPaint(ctx, this, "stroke");
    ctx.lineWidth = this.strokeWidth;
    if (this.dashArray.length > 0) ctx.setLineDash(this.dashArray);
    ctx.stroke();

    ctx.restore();
  }

  clone(): CircleShape {
    return new CircleShape(this.toJSON());
  }
}

/** 圆形能力条目（ADR-0007 切片 4）：基础可绑定 */
export const circleCapability: ShapeCapability = {
  type: "circle",
  bindableProps: baseBindableProps(),
};
