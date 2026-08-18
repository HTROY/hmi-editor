import type { ShapeBase } from "./ShapeBase";
import type { BoundingBox, Point } from "../types";
import type { AnimationFrameState } from "../bindings/animation";
import { applyAnimationToPoint } from "./animationGeometry";

// ============================================================
// resizeCore — 图元手柄调整的通用几何机制（ADR-0007 切片 2）
//
// 只含与图元类型无关的公共机制：AABB/手柄/指针约束/盒式缩放。
// 逐类型行为（直线端点、组原点、字号联动、路径点阵重算、
// metro 恒等比）经图元能力表（capability.ts）分发，
// 各覆盖函数在本模块的盒式机制之上叠加自身联动。
// ============================================================

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface ResizeOptions {
  /** Shift：等比缩放 */
  proportional?: boolean;
  /** 20px 网格吸附；Alt 临时关闭 */
  snap?: boolean;
  gridSize?: number;
  /** 最小尺寸，默认 1px */
  minSize?: number;
}

/** 归一化后的单次 resize 请求（applyResize 入口统一归一化后传入能力条目） */
export interface ResizeInput {
  proportional: boolean;
  snap: boolean;
  gridSize: number;
  minSize: number;
}

/** applyBoxResize 的结果：供逐类型覆盖做联动（字号/路径点阵） */
export interface BoxResizeResult {
  /** 起始 AABB */
  bb: BoundingBox;
  /** 最终目标 AABB（等比修正/旋转反解之后） */
  target: BoundingBox;
  /** 本帧缩放前的宽高 */
  oldWidth: number;
  oldHeight: number;
  /** 手柄方向 */
  dir: { x: number; y: number };
}

export const HANDLE_DIR: Record<
  ResizeHandle,
  { x: -1 | 0 | 1; y: -1 | 0 | 1 }
> = {
  nw: { x: -1, y: -1 },
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
};

const HANDLE_ORDER: ResizeHandle[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

export function normalizeRotation(rotation: number): number {
  if (!Number.isFinite(rotation)) return 0;
  const r = ((rotation % 360) + 360) % 360;
  return r >= 359.999 ? 0 : r;
}

/** 数值吸附到网格（默认 20px） */
export function snapValue(
  value: number,
  gridSize = 20,
  enabled = true
): number {
  if (!enabled || gridSize <= 0) return value;
  return Math.round(value / gridSize) * gridSize;
}

/**
 * 旋转感知的屏幕轴对齐外接框（AABB）。
 * 普通图元绕自身中心旋转；组绕组原点旋转，因此两者旋转锚点不同。
 * 直线渲染不应用旋转，直接使用端点包围盒。
 */
export function getRotatedAABB(shape: ShapeBase): BoundingBox {
  const local = shape.boundingBox;
  const rotation = normalizeRotation(shape.rotation);
  if (rotation === 0 || shape.type === "line") return { ...local };

  const pivot =
    shape.type === "group"
      ? { x: shape.x, y: shape.y }
      : {
          x: local.x + local.width / 2,
          y: local.y + local.height / 2,
        };
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const corners: Point[] = [
    { x: local.x, y: local.y },
    { x: local.x + local.width, y: local.y },
    { x: local.x + local.width, y: local.y + local.height },
    { x: local.x, y: local.y + local.height },
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    const dx = c.x - pivot.x;
    const dy = c.y - pivot.y;
    const rx = pivot.x + dx * cos - dy * sin;
    const ry = pivot.y + dx * sin + dy * cos;
    minX = Math.min(minX, rx);
    minY = Math.min(minY, ry);
    maxX = Math.max(maxX, rx);
    maxY = Math.max(maxY, ry);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 叠加动画帧状态后的屏幕轴对齐外接框。
 * 先按静态旋转得到 AABB，再把它 4 个角点经过动画变换（位移/旋转/缩放）后重取 AABB。
 */
export function getAnimatedAABB(
  shape: ShapeBase,
  anim: AnimationFrameState
): BoundingBox {
  const bb = getRotatedAABB(shape);
  const corners: Point[] = [
    { x: bb.x, y: bb.y },
    { x: bb.x + bb.width, y: bb.y },
    { x: bb.x + bb.width, y: bb.y + bb.height },
    { x: bb.x, y: bb.y + bb.height },
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    const t = applyAnimationToPoint(shape, c, anim);
    minX = Math.min(minX, t.x);
    minY = Math.min(minY, t.y);
    maxX = Math.max(maxX, t.x);
    maxY = Math.max(maxY, t.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** 返回 8 个手柄的世界坐标（按 AABB 排布） */
export function getResizeHandles(
  shape: ShapeBase,
  anim?: AnimationFrameState
): Record<ResizeHandle, Point> {
  const bb = anim ? getAnimatedAABB(shape, anim) : getRotatedAABB(shape);
  return {
    nw: { x: bb.x, y: bb.y },
    n: { x: bb.x + bb.width / 2, y: bb.y },
    ne: { x: bb.x + bb.width, y: bb.y },
    e: { x: bb.x + bb.width, y: bb.y + bb.height / 2 },
    se: { x: bb.x + bb.width, y: bb.y + bb.height },
    s: { x: bb.x + bb.width / 2, y: bb.y + bb.height },
    sw: { x: bb.x, y: bb.y + bb.height },
    w: { x: bb.x, y: bb.y + bb.height / 2 },
  };
}

/** 命中测试：返回容差内最近的手柄 */
export function hitTestResizeHandle(
  shape: ShapeBase,
  point: Point,
  tolerance = 6,
  anim?: AnimationFrameState
): ResizeHandle | null {
  const handles = getResizeHandles(shape, anim);
  let best: ResizeHandle | null = null;
  let bestDist = Infinity;
  for (const key of HANDLE_ORDER) {
    const h = handles[key];
    const d = Math.hypot(point.x - h.x, point.y - h.y);
    if (d <= tolerance && d < bestDist) {
      best = key;
      bestDist = d;
    }
  }
  return best;
}

/** 归一化单次 resize 请求（吸附默认开、网格 20、最小 1px） */
export function normalizeOptions(options: ResizeOptions): ResizeInput {
  return {
    proportional: options.proportional === true,
    snap: options.snap !== false,
    gridSize: options.gridSize ?? 20,
    minSize: Math.max(1, options.minSize ?? 1),
  };
}

/** 根据指针计算目标 AABB（吸附 + 最小尺寸 + 不越过锚点） */
export function buildTargetBox(
  bb: BoundingBox,
  dir: { x: number; y: number },
  pointer: Point,
  o: ResizeInput
): BoundingBox {
  const px = snapValue(pointer.x, o.gridSize, o.snap);
  const py = snapValue(pointer.y, o.gridSize, o.snap);
  const ax = dir.x === -1 ? bb.x + bb.width : bb.x;
  const ay = dir.y === -1 ? bb.y + bb.height : bb.y;
  const left = dir.x === -1 ? Math.min(px, ax - o.minSize) : bb.x;
  const right = dir.x === 1 ? Math.max(px, ax + o.minSize) : bb.x + bb.width;
  const top = dir.y === -1 ? Math.min(py, ay - o.minSize) : bb.y;
  const bottom = dir.y === 1 ? Math.max(py, ay + o.minSize) : bb.y + bb.height;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 把目标 AABB 修正为等比版本：拖动的轴决定比例，另一轴绕自身中心缩放 */
export function buildUniformTarget(
  bb: BoundingBox,
  target: BoundingBox,
  dir: { x: number; y: number },
  minSize: number
): BoundingBox {
  const kx = dir.x !== 0 ? target.width / bb.width : 1;
  const ky = dir.y !== 0 ? target.height / bb.height : 1;
  const k = Math.max(
    dir.x !== 0 && dir.y !== 0 ? Math.max(kx, ky) : dir.x !== 0 ? kx : ky,
    minSize / bb.width,
    minSize / bb.height
  );
  const width = bb.width * k;
  const height = bb.height * k;
  const ax = dir.x === -1 ? bb.x + bb.width : bb.x;
  const ay = dir.y === -1 ? bb.y + bb.height : bb.y;
  return {
    x:
      dir.x === -1
        ? ax - width
        : dir.x === 1
          ? ax
          : bb.x + bb.width / 2 - width / 2,
    y:
      dir.y === -1
        ? ay - height
        : dir.y === 1
          ? ay
          : bb.y + bb.height / 2 - height / 2,
    width,
    height,
  };
}

/**
 * 旋转图元：由目标 AABB 反解本地宽高。
 * 本地框绕中心旋转时 AABB = w|cosθ| + h|sinθ|（宽）与 w|sinθ| + h|cosθ|（高），
 * 可逆解得 w/h；在 |cosθ|≈|sinθ| 或解无效时回退等比。
 */
function solveRotatedDims(
  _aabb: BoundingBox,
  target: BoundingBox,
  rotationDeg: number,
  minSize: number
): { width: number; height: number } | null {
  const rad = (rotationDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const denom = c * c - s * s;
  if (Math.abs(denom) < 1e-6) return null;
  const width = (target.width * c - target.height * s) / denom;
  const height = (target.height * c - target.width * s) / denom;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < minSize ||
    height < minSize
  ) {
    return null;
  }
  return { width, height };
}

/** 以 AABB 为目标把盒式图元等比缩放（返回最终 AABB，供字号联动使用） */
function applyUniformBox(
  shape: ShapeBase,
  bb: BoundingBox,
  target: BoundingBox,
  dir: { x: number; y: number },
  minSize: number,
  oldWidth: number,
  oldHeight: number
): BoundingBox {
  const uniformTarget = buildUniformTarget(bb, target, dir, minSize);
  const k = uniformTarget.width / bb.width;
  const width = oldWidth * k;
  const height = oldHeight * k;
  shape.width = width;
  shape.height = height;
  shape.x = uniformTarget.x + uniformTarget.width / 2 - width / 2;
  shape.y = uniformTarget.y + uniformTarget.height / 2 - height / 2;
  return uniformTarget;
}

/**
 * 常规盒式图元（rect/circle/image 与各覆盖函数的公共基底）：
 * AABB 调整 + 旋转反解 + 等比修正。返回结果供逐类型覆盖叠加
 * 字号联动 / 路径点阵重算等尾部逻辑。
 */
export function applyBoxResize(
  shape: ShapeBase,
  handle: ResizeHandle,
  pointer: Point,
  o: ResizeInput
): BoxResizeResult {
  const dir = HANDLE_DIR[handle];
  const rotated = normalizeRotation(shape.rotation) !== 0;
  const bb = rotated ? getRotatedAABB(shape) : shape.boundingBox;
  const uniform = o.proportional;
  const oldWidth = shape.width;
  const oldHeight = shape.height;
  let target = buildTargetBox(bb, dir, pointer, o);

  if (!uniform && !rotated) {
    shape.x = target.x;
    shape.y = target.y;
    shape.width = target.width;
    shape.height = target.height;
  } else {
    const solved = uniform
      ? null
      : solveRotatedDims(bb, target, shape.rotation, o.minSize);
    if (solved) {
      shape.width = solved.width;
      shape.height = solved.height;
      shape.x = target.x + target.width / 2 - solved.width / 2;
      shape.y = target.y + target.height / 2 - solved.height / 2;
    } else {
      target = applyUniformBox(
        shape,
        bb,
        target,
        dir,
        o.minSize,
        oldWidth,
        oldHeight
      );
    }
  }
  return { bb, target, dir, oldWidth, oldHeight };
}
