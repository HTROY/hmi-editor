import { ShapeBase } from "./ShapeBase";
import { createShape } from "./factory";
import type { ShapeProps, Point, BoundingBox } from "../types";

// ============================================================
// GroupShape — 组图元：一组子图元的容器
// 子图元坐标相对组原点；整体缩放/移动时保持相对布局
// ============================================================

export class GroupShape extends ShapeBase {
  children: ShapeBase[];

  constructor(props?: Partial<ShapeProps>) {
    super("group", props);
    this.children = (
      Array.isArray(props?.children) ? props!.children! : []
    ).map((childProps) => createShape(childProps.type, childProps));
  }

  get boundingBox(): BoundingBox {
    if (this.children.length === 0) return super.boundingBox;
    const boxes = this.children.map((c) => c.boundingBox);
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.width));
    const maxY = Math.max(...boxes.map((b) => b.y + b.height));
    return {
      x: this.x + minX,
      y: this.y + minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  hitTest(point: Point): boolean {
    if (this.children.length === 0) {
      return this.hitTestLocalBox(point);
    }

    // 组内坐标 = 世界坐标先减去组原点并逆旋转
    const dx = point.x - this.x;
    const dy = point.y - this.y;
    const rad = -this.rotation * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const local = {
      x: dx * cos - dy * sin,
      y: dx * sin + dy * cos,
    };
    for (let i = this.children.length - 1; i >= 0; i--) {
      if (this.children[i].hitTest(local)) return true;
    }
    return false;
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation * (Math.PI / 180));
    ctx.globalAlpha = this.opacity;
    for (const child of this.children) child.render(ctx);
    ctx.restore();
  }

  clone(): GroupShape {
    return new GroupShape(this.toJSON());
  }

  fromJSON(props: ShapeProps): void {
    super.fromJSON(props);
    this.children = (Array.isArray(props.children) ? props.children : []).map(
      (childProps) => createShape(childProps.type, childProps)
    );
  }

  toJSON(): ShapeProps {
    return {
      ...super.toJSON(),
      children: this.children.map((c) => c.toJSON()),
    };
  }
}
