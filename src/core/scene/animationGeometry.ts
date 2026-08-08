import type { AnimationFrameState } from "../bindings/animation";
import type { Point } from "../types";

// ============================================================
// animationGeometry — 动画几何变换（core 层纯几何）
// 渲染器叠加动画帧状态时使用同一套变换：
//   世界点 = 图元中心 + 位移 + 旋转(缩放(静态点 - 中心))
// 命中测试与选中框通过正向/逆向变换与视觉保持一致
// ============================================================

export interface AnimationShapeLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 正向：把图元静态坐标点按动画帧状态变换到世界坐标（与渲染一致） */
export function applyAnimationToPoint(
  shape: AnimationShapeLike,
  point: Point,
  anim: AnimationFrameState
): Point {
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  const dx = anim.dx ?? 0;
  const dy = anim.dy ?? 0;
  const rotation = anim.rotation ?? 0;
  const sx = anim.scaleX ?? 1;
  const sy = anim.scaleY ?? 1;
  if (dx === 0 && dy === 0 && rotation === 0 && sx === 1 && sy === 1) {
    return { x: point.x, y: point.y };
  }
  const relX = (point.x - cx) * sx;
  const relY = (point.y - cy) * sy;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: cx + dx + relX * cos - relY * sin,
    y: cy + dy + relX * sin + relY * cos,
  };
}

/** 逆向：把世界坐标点还原为图元静态坐标，供命中测试使用 */
export function inverseAnimationToStatic(
  shape: AnimationShapeLike,
  point: Point,
  anim: AnimationFrameState
): Point {
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  const dx = anim.dx ?? 0;
  const dy = anim.dy ?? 0;
  const rotation = anim.rotation ?? 0;
  const sx = anim.scaleX ?? 1;
  const sy = anim.scaleY ?? 1;
  if (dx === 0 && dy === 0 && rotation === 0 && sx === 1 && sy === 1) {
    return { x: point.x, y: point.y };
  }
  const tx = point.x - (cx + dx);
  const ty = point.y - (cy + dy);
  const rad = (-rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rx = tx * cos - ty * sin;
  const ry = tx * sin + ty * cos;
  return { x: cx + rx / sx, y: cy + ry / sy };
}
