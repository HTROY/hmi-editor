import { ShapeBase } from "./ShapeBase";
import type { ShapeProps, Point, BoundingBox } from "../types";
import { getPaint } from "./paint";
import { getResizeHandles, HANDLE_DIR, snapValue } from "./resizeCore";
import type { ResizeHandle, ResizeInput } from "./resizeCore";
import type { ShapeCapability } from "./capability";
import { baseBindableProps } from "./bindable";

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

    ctx.strokeStyle = getPaint(ctx, this, "stroke");
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

  scale(sx: number, sy: number): void {
    super.scale(sx, sy);
    this.startPoint = {
      x: this.startPoint.x * sx,
      y: this.startPoint.y * sy,
    };
    this.endPoint = {
      x: this.endPoint.x * sx,
      y: this.endPoint.y * sy,
    };
  }

  toJSON(): ShapeProps {
    return {
      ...super.toJSON(),
      startPoint: { ...this.startPoint },
      endPoint: { ...this.endPoint },
    };
  }
}

/** 直线的手柄 resize：调整离手柄最近的端点（能力条目，ADR-0007 切片 2） */
function applyLineResize(
  shape: LineShape,
  handle: ResizeHandle,
  pointer: Point,
  o: ResizeInput
): void {
  const dir = HANDLE_DIR[handle];
  const px = snapValue(pointer.x, o.gridSize, o.snap);
  const py = snapValue(pointer.y, o.gridSize, o.snap);
  const hPos = getResizeHandles(shape)[handle];
  const dStart = Math.hypot(
    hPos.x - shape.startPoint.x,
    hPos.y - shape.startPoint.y
  );
  const dEnd = Math.hypot(hPos.x - shape.endPoint.x, hPos.y - shape.endPoint.y);
  const moveStart = dStart <= dEnd;
  const fixed = moveStart ? shape.endPoint : shape.startPoint;
  const moving = moveStart ? shape.startPoint : shape.endPoint;

  let nx = moving.x;
  let ny = moving.y;
  if (dir.x !== 0 && dir.y !== 0) {
    nx = px;
    ny = py;
  } else if (dir.x !== 0) {
    nx = px;
  } else {
    ny = py;
  }

  if (o.proportional) {
    // 保持斜率：沿原方向缩放端点，最小长度 1px
    const vx = moving.x - fixed.x;
    const vy = moving.y - fixed.y;
    const len2 = vx * vx + vy * vy;
    if (len2 === 0) {
      const dx = px - fixed.x;
      const dy = py - fixed.y;
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.max(1, o.minSize / d);
      nx = fixed.x + (dx / d) * k;
      ny = fixed.y + (dy / d) * k;
    } else {
      const proj = ((px - fixed.x) * vx + (py - fixed.y) * vy) / len2;
      const k = Math.max(proj, o.minSize / Math.sqrt(len2));
      nx = fixed.x + vx * k;
      ny = fixed.y + vy * k;
    }
  } else {
    // 非等比：拖过锚点时按原方向夹紧，保持最小长度
    if (dir.x !== 0 && dir.y !== 0) {
      const dx = nx - fixed.x;
      const dy = ny - fixed.y;
      const d = Math.hypot(dx, dy);
      if (d < o.minSize) {
        const vx = moving.x - fixed.x || 1;
        const vy = moving.y - fixed.y || 1;
        const len = Math.hypot(vx, vy);
        nx = fixed.x + (vx / len) * o.minSize;
        ny = fixed.y + (vy / len) * o.minSize;
      }
    } else if (dir.x !== 0) {
      const dx = nx - fixed.x;
      if (Math.abs(dx) < o.minSize) {
        nx =
          fixed.x +
          (Math.sign(dx) || Math.sign(moving.x - fixed.x) || 1) * o.minSize;
      }
    } else {
      const dy = ny - fixed.y;
      if (Math.abs(dy) < o.minSize) {
        ny =
          fixed.y +
          (Math.sign(dy) || Math.sign(moving.y - fixed.y) || 1) * o.minSize;
      }
    }
  }

  if (moveStart) shape.startPoint = { x: nx, y: ny };
  else shape.endPoint = { x: nx, y: ny };
}

/** 绝对点集几何：直线 = 两端点（能力条目，ADR-0007 切片 3） */
function lineBoundsFromProps(props: ShapeProps): BoundingBox {
  const start = props.startPoint ?? { x: props.x, y: props.y };
  const end = props.endPoint ?? {
    x: props.x + props.width,
    y: props.y + props.height,
  };
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x) || 1,
    height: Math.abs(end.y - start.y) || 1,
  };
}

export const lineCapability: ShapeCapability = {
  type: "line",
  // 窄类型入参经能力接口桥接（strict 逆变）：分发正确性由 capabilityOf 按类型保证
  bindableProps: baseBindableProps(),
  resize: applyLineResize as ShapeCapability["resize"],
  points: {
    get: (shape) => {
      const l = shape as LineShape;
      return [{ ...l.startPoint }, { ...l.endPoint }];
    },
    set: (shape, pts) => {
      const l = shape as LineShape;
      l.startPoint = { ...pts[0] };
      l.endPoint = { ...pts[1] };
    },
    read: (props) => [
      props.startPoint ?? { x: 0, y: 0 },
      props.endPoint ?? { x: 0, y: 0 },
    ],
    write: (props, pts) => ({
      ...props,
      startPoint: { ...pts[0] },
      endPoint: { ...pts[1] },
    }),
  },
  boundsFromProps: lineBoundsFromProps,
};
