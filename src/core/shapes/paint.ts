import type { ShapeGradient } from "../types";
import type { ShapeBase } from "./ShapeBase";

// ============================================================
// paint — 画刷解析：支持纯色与 SVG 导入的渐变填充
// 渐变坐标统一为 objectBoundingBox 单位（0..1），
// 渲染时按图元本地宽高映射到画布坐标。
// ============================================================

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 解析渐变或回退到纯色，返回 CanvasGradient / CSS 颜色字符串 */
export function getPaint(
  ctx: CanvasRenderingContext2D,
  shape: ShapeBase,
  kind: "fill" | "stroke"
): string | CanvasGradient {
  const gradient: ShapeGradient | null =
    kind === "fill" ? shape.fillGradient : shape.strokeGradient;
  const fallback = kind === "fill" ? shape.fill : shape.stroke;
  if (!gradient || gradient.stops.length === 0) return fallback;

  const w = Math.max(1e-6, shape.width);
  const h = Math.max(1e-6, shape.height);

  let canvasGradient: CanvasGradient;
  if (gradient.type === "linear") {
    canvasGradient = ctx.createLinearGradient(
      gradient.x1 * w,
      gradient.y1 * h,
      gradient.x2 * w,
      gradient.y2 * h
    );
  } else {
    const r = Math.max(w, h) * Math.max(1e-6, gradient.r);
    const cx = gradient.cx * w;
    const cy = gradient.cy * h;
    const fx = (gradient.fx ?? gradient.cx) * w;
    const fy = (gradient.fy ?? gradient.cy) * h;
    canvasGradient = ctx.createRadialGradient(fx, fy, 0, cx, cy, r);
  }

  for (const stop of gradient.stops) {
    canvasGradient.addColorStop(clamp01(stop.offset), stop.color);
  }
  return canvasGradient;
}
