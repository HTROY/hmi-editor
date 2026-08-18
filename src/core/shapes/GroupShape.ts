import { ShapeBase } from "./ShapeBase";
import { createShape } from "./factory";
import type { ShapeProps, Point, BoundingBox } from "../types";
import {
  HANDLE_DIR,
  buildTargetBox,
  buildUniformTarget,
  getRotatedAABB,
  normalizeRotation,
} from "./resizeCore";
import type { ResizeHandle, ResizeInput } from "./resizeCore";
import type { ShapeCapability } from "./capability";
import { baseBindableProps } from "./bindable";

// ============================================================
// GroupShape — 组图元：一组子图元的容器
// 子图元坐标相对组原点；整体缩放/移动时保持相对布局
// ============================================================

export class GroupShape extends ShapeBase {
  children: ShapeBase[];

  constructor(props?: Partial<ShapeProps>) {
    super("group", props);
    // children 三态：未指定（工具栏新建组）→ 演示子图元；null/非数组（损坏数据）→ 空组
    const rawChildren = props?.children;
    const children: ShapeProps[] = Array.isArray(rawChildren)
      ? rawChildren
      : rawChildren === undefined
        ? [
            createShape("rect", {
              x: 0,
              y: 0,
              width: 70,
              height: 60,
              fill: "#4A90D9",
              stroke: "#333333",
              strokeWidth: 2,
            }).toJSON(),
            createShape("circle", {
              x: 80,
              y: 5,
              width: 55,
              height: 55,
              fill: "#E67E22",
              stroke: "#333333",
              strokeWidth: 2,
            }).toJSON(),
          ]
        : [];
    this.children = children.map((childProps) =>
      createShape(childProps.type, childProps)
    );
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

  scale(sx: number, sy: number): void {
    super.scale(sx, sy);
    for (const child of this.children) child.scale(sx, sy);
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

/** 组的手柄 resize：原点按锚点缩放，子图元整体缩放保持相对布局（能力条目，ADR-0007 切片 2） */
function applyGroupResize(
  shape: GroupShape,
  handle: ResizeHandle,
  pointer: Point,
  o: ResizeInput
): void {
  const dir = HANDLE_DIR[handle];
  const rotated = normalizeRotation(shape.rotation) !== 0;
  const bb = rotated ? getRotatedAABB(shape) : shape.boundingBox;
  let target = buildTargetBox(bb, dir, pointer, o);
  if (rotated || o.proportional) {
    target = buildUniformTarget(bb, target, dir, o.minSize);
  }
  const sx = target.width / bb.width;
  const sy = target.height / bb.height;
  const ax = dir.x === -1 ? bb.x + bb.width : bb.x;
  const ay = dir.y === -1 ? bb.y + bb.height : bb.y;
  shape.x = ax + (shape.x - ax) * sx;
  shape.y = ay + (shape.y - ay) * sy;
  for (const child of shape.children) child.scale(sx, sy);
}

export const groupCapability: ShapeCapability = {
  type: "group",
  // 窄类型入参经能力接口桥接（strict 逆变）：分发正确性由 capabilityOf 按类型保证
  editor: [
    {
      key: "children",
      label: "子图元",
      kind: "readonly",
      get: (s) => (s as GroupShape).children.length,
    },
  ],
  bindableProps: baseBindableProps(),
  resize: applyGroupResize as ShapeCapability["resize"],
};
