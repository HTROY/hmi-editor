import { ShapeBase } from './ShapeBase';
import type { ShapeProps, Point } from '../types';

// ============================================================
// RectShape — 矩形
// ============================================================

export class RectShape extends ShapeBase {
  cornerRadius: number;

  constructor(props?: Partial<ShapeProps>) {
    super('rect', props);
    this.cornerRadius = props?.cornerRadius ?? 0;
  }

  hitTest(point: Point): boolean {
    // 考虑旋转，先逆旋转点回图元本地坐标系
    const dx = point.x - this.center.x;
    const dy = point.y - this.center.y;
    const rad = -this.rotation * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const localX = dx * cos - dy * sin + this.width / 2;
    const localY = dx * sin + dy * cos + this.height / 2;

    return (
      localX >= 0 &&
      localX <= this.width &&
      localY >= 0 &&
      localY <= this.height
    );
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;
    ctx.save();
    ctx.translate(this.x + this.width / 2, this.y + this.height / 2);
    ctx.rotate(this.rotation * (Math.PI / 180));
    ctx.translate(-this.width / 2, -this.height / 2);
    ctx.globalAlpha = this.opacity;

    ctx.beginPath();
    if (this.cornerRadius && this.cornerRadius > 0) {
      ctx.roundRect(0, 0, this.width, this.height, this.cornerRadius);
    } else {
      ctx.rect(0, 0, this.width, this.height);
    }

    ctx.fillStyle = this.fill;
    ctx.fill();
    ctx.strokeStyle = this.stroke;
    ctx.lineWidth = this.strokeWidth;
    if (this.dashArray.length > 0) {
      ctx.setLineDash(this.dashArray);
    }
    ctx.stroke();

    ctx.restore();
  }

  clone(): RectShape {
    const c = new RectShape(this.toJSON());
    c.cornerRadius = this.cornerRadius;
    return c;
  }

  toJSON(): ShapeProps {
    return { ...super.toJSON(), cornerRadius: this.cornerRadius };
  }
}
