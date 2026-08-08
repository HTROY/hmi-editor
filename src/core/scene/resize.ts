import { ShapeBase } from "../shapes/ShapeBase";
import { GroupShape } from "../shapes/GroupShape";
import { LineShape } from "../shapes/LineShape";
import { PathShape } from "../shapes/PathShape";
import { TextShape } from "../shapes/TextShape";
import { transformPathData } from "../shapes/pathTransform";
import type { BoundingBox, Point } from "../types";

// ============================================================
// resize — 手柄调整图元大小（core 层纯几何）
// 规则：
// - 8 个手柄按“屏幕轴对齐外接框（AABB）”定位，旋转图元同样按 AABB 调整；
// - Shift 等比；Alt 关闭 20px 网格吸附；最小尺寸 1px；
// - 文本字号仅在对角锚点缩放时按较紧的宽高比例联动（边锚点只改文本框），直线直接改端点，metro 专用图元始终等比，
//   组整体缩放时子图元相对布局保持不变。
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

const HANDLE_DIR: Record<ResizeHandle, { x: -1 | 0 | 1; y: -1 | 0 | 1 }> = {
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

/** metro 专用图元：语义上必须等比缩放 */
const METRO_TYPES = new Set<string>([
  "metro-breaker",
  "metro-busbar",
  "metro-fan",
  "metro-signal",
  "metro-gauge",
  "metro-transformer",
]);

function normalizeRotation(rotation: number): number {
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

/** 返回 8 个手柄的世界坐标（按 AABB 排布） */
export function getResizeHandles(
  shape: ShapeBase
): Record<ResizeHandle, Point> {
  const bb = getRotatedAABB(shape);
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
  tolerance = 6
): ResizeHandle | null {
  const handles = getResizeHandles(shape);
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

interface InternalOptions {
  proportional: boolean;
  snap: boolean;
  gridSize: number;
  minSize: number;
}

function normalizeOptions(options: ResizeOptions): InternalOptions {
  return {
    proportional: options.proportional === true,
    snap: options.snap !== false,
    gridSize: options.gridSize ?? 20,
    minSize: Math.max(1, options.minSize ?? 1),
  };
}

/** 根据指针计算目标 AABB（吸附 + 最小尺寸 + 不越过锚点） */
function buildTargetBox(
  bb: BoundingBox,
  dir: { x: number; y: number },
  pointer: Point,
  o: InternalOptions
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
function buildUniformTarget(
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
  aabb: BoundingBox,
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

/** 常规盒式图元（rect/circle/text/path/image/metro）：AABB 调整 */
function applyBoxResize(
  shape: ShapeBase,
  handle: ResizeHandle,
  pointer: Point,
  o: InternalOptions
): void {
  const dir = HANDLE_DIR[handle];
  const rotated = normalizeRotation(shape.rotation) !== 0;
  const bb = rotated ? getRotatedAABB(shape) : shape.boundingBox;
  const uniform = o.proportional || METRO_TYPES.has(shape.type);
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

  if (shape.type === "text" && dir.x !== 0 && dir.y !== 0) {
    const kFont = Math.min(target.width / bb.width, target.height / bb.height);
    (shape as TextShape).fontSize = Math.max(
      1,
      (shape as TextShape).fontSize * kFont
    );
  } else if (shape.type === "path") {
    (shape as PathShape).d = transformPathData(
      (shape as PathShape).d,
      shape.width / oldWidth,
      shape.height / oldHeight
    );
  } else if (shape.type === "polyline" || shape.type === "polygon") {
    const pts = (shape as unknown as { points: Point[] }).points;
    const kx = shape.width / oldWidth;
    const ky = shape.height / oldHeight;
    (shape as unknown as { points: Point[] }).points = pts.map((p) => ({
      x: p.x * kx,
      y: p.y * ky,
    }));
  }
}

/** 直线：调整离手柄最近的端点 */
function applyLineResize(
  shape: LineShape,
  handle: ResizeHandle,
  pointer: Point,
  o: InternalOptions
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

/** 组：原点按锚点缩放，子图元等比/非等比整体缩放，保持相对布局 */
function applyGroupResize(
  shape: GroupShape,
  handle: ResizeHandle,
  pointer: Point,
  o: InternalOptions
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

/**
 * 对图元原地应用一次手柄调整（拖动过程中反复调用）。
 * 编辑器配合 beginShapeEdit/endShapeEdit 实现整体撤销。
 */
export function applyResize(
  shape: ShapeBase,
  handle: ResizeHandle,
  pointer: Point,
  options: ResizeOptions = {}
): void {
  const o = normalizeOptions(options);
  if (shape.type === "line") {
    applyLineResize(shape as LineShape, handle, pointer, o);
    return;
  }
  if (shape.type === "group") {
    applyGroupResize(shape as GroupShape, handle, pointer, o);
    return;
  }
  applyBoxResize(shape, handle, pointer, o);
}
