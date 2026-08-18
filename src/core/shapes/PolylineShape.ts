import { ShapeBase } from "./ShapeBase";
import { getPaint } from "./paint";
import type { ShapeProps, Point, BoundingBox } from "../types";
import { applyBoxResize } from "./resizeCore";
import type { ResizeHandle, ResizeInput } from "./resizeCore";
import type { ShapeCapability } from "./capability";
import { baseBindableProps } from "./bindable";

// ============================================================
// PolylineShape — 折线（SVG polyline 导入产物）
// 点位为世界坐标（组内为相对组原点的坐标）
// ============================================================

export class PolylineShape extends ShapeBase {
  points: Point[];

  constructor(props?: Partial<ShapeProps>) {
    super("polyline", props);
    this.points = Array.isArray(props?.points)
      ? props!.points!.map((p) => ({ ...p }))
      : [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
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
    if (!this.visible || this.points.length < 2) return;
    ctx.save();
    ctx.globalAlpha = this.opacity;

    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) {
      ctx.lineTo(this.points[i].x, this.points[i].y);
    }

    // SVG 折线若带填充，填充时按闭合路径处理，描边保持开放
    if (this.fill !== "transparent") {
      ctx.save();
      ctx.closePath();
      ctx.fillStyle = getPaint(ctx, this, "fill");
      ctx.fill();
      ctx.restore();
    }

    ctx.strokeStyle = getPaint(ctx, this, "stroke");
    ctx.lineWidth = this.strokeWidth;
    if (this.dashArray.length > 0) ctx.setLineDash(this.dashArray);
    ctx.stroke();
    ctx.restore();
  }

  clone(): PolylineShape {
    return new PolylineShape(this.toJSON());
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

/** 折线的手柄 resize：盒式缩放 + 点位按宽高比重算（能力条目，ADR-0007 切片 2） */
function applyPolylineResize(
  shape: PolylineShape,
  handle: ResizeHandle,
  pointer: Point,
  o: ResizeInput
): void {
  const r = applyBoxResize(shape, handle, pointer, o);
  const kx = shape.width / r.oldWidth;
  const ky = shape.height / r.oldHeight;
  shape.points = shape.points.map((p) => ({ x: p.x * kx, y: p.y * ky }));
}

/** 绝对点集几何与包围盒：折线（能力条目，ADR-0007 切片 3） */
function polylineBoundsFromProps(props: ShapeProps): BoundingBox {
  const points = props.points ?? [];
  if (points.length === 0) {
    return { x: props.x, y: props.y, width: props.width, height: props.height };
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs) || 1,
    height: Math.max(...ys) - Math.min(...ys) || 1,
  };
}

export const polylineCapability: ShapeCapability = {
  type: "polyline",
  // 窄类型入参经能力接口桥接（strict 逆变）：分发正确性由 capabilityOf 按类型保证
  bindableProps: baseBindableProps(),
  resize: applyPolylineResize as ShapeCapability["resize"],
  points: {
    get: (shape) => (shape as PolylineShape).points.map((p) => ({ ...p })),
    set: (shape, pts) => {
      (shape as PolylineShape).points = pts.map((p) => ({ ...p }));
    },
    read: (props) => (props.points ?? []).map((p) => ({ ...p })),
    write: (props, pts) => ({ ...props, points: pts.map((p) => ({ ...p })) }),
  },
  boundsFromProps: polylineBoundsFromProps,
};
