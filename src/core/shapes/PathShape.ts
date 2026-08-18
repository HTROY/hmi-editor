import { ShapeBase } from "./ShapeBase";
import { getPaint } from "./paint";
import type { ShapeProps, Point } from "../types";
import { transformPathData } from "./pathTransform";
import { applyBoxResize } from "./resizeCore";
import type { ResizeHandle, ResizeInput } from "./resizeCore";
import type { ShapeCapability } from "./capability";
import { baseBindableProps } from "./bindable";

// ============================================================
// PathShape — 路径图元（SVG path 数据，矢量导入/编辑的基础）
// ============================================================

export class PathShape extends ShapeBase {
  d: string;

  constructor(props?: Partial<ShapeProps>) {
    super("path", props);
    this.d = props?.d ?? "M15 10 L105 10 L105 70 L15 70 Z";
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
    ctx.fillStyle = getPaint(ctx, this, "fill");
    ctx.fill(path);
    ctx.strokeStyle = getPaint(ctx, this, "stroke");
    ctx.lineWidth = this.strokeWidth;
    if (this.dashArray.length > 0) ctx.setLineDash(this.dashArray);
    ctx.stroke(path);

    ctx.restore();
  }

  clone(): PathShape {
    return new PathShape(this.toJSON());
  }

  scale(sx: number, sy: number): void {
    super.scale(sx, sy);
    this.d = transformPathData(this.d, sx, sy);
  }

  toJSON(): ShapeProps {
    return { ...super.toJSON(), d: this.d };
  }
}

/** 路径的手柄 resize：盒式缩放 + d 随宽高比重写（能力条目，ADR-0007 切片 2） */
function applyPathResize(
  shape: PathShape,
  handle: ResizeHandle,
  pointer: Point,
  o: ResizeInput
): void {
  const r = applyBoxResize(shape, handle, pointer, o);
  shape.d = transformPathData(
    shape.d,
    shape.width / r.oldWidth,
    shape.height / r.oldHeight
  );
}

export const pathCapability: ShapeCapability = {
  type: "path",
  // 窄类型入参经能力接口桥接（strict 逆变）：分发正确性由 capabilityOf 按类型保证
  editor: [
    {
      key: "d",
      label: "路径 d",
      kind: "textarea",
      get: (s) => (s as PathShape).d,
    },
  ],
  bindableProps: baseBindableProps(),
  resize: applyPathResize as ShapeCapability["resize"],
};
