import { ShapeBase } from "../shapes/ShapeBase";
import type { SceneGraph } from "./SceneGraph";
import type { BoundingBox } from "../types";

/** 新分辨率相对旧分辨率的等比缩放系数（取较紧的维度） */
export function computeScaleFactor(
  oldWidth: number,
  oldHeight: number,
  newWidth: number,
  newHeight: number
): number {
  if (oldWidth <= 0 || oldHeight <= 0 || newWidth <= 0 || newHeight <= 0) {
    return 1;
  }
  return Math.min(newWidth / oldWidth, newHeight / oldHeight);
}

/** 对一个图元做等比缩放（原地修改，不改坐标原点语义） */
export function scaleShape(shape: ShapeBase, factor: number): void {
  if (factor === 1) return;
  shape.scale(factor, factor);
}

/** 把场景内所有图元按比例缩放到新分辨率，返回实际使用的系数 */
export function scaleSceneToPage(
  scene: SceneGraph,
  oldWidth: number,
  oldHeight: number,
  newWidth: number,
  newHeight: number
): number {
  const factor = computeScaleFactor(oldWidth, oldHeight, newWidth, newHeight);
  if (factor === 1) return factor;
  for (const shape of scene.getAll()) scaleShape(shape, factor);
  return factor;
}

export interface OutOfBoundsShape {
  id: string;
  name: string;
  bbox: BoundingBox;
}

/** 找出完全位于页面边界外的图元（含跨越边界的） */
export function getOutOfBoundsShapes(
  scene: SceneGraph,
  pageWidth: number,
  pageHeight: number
): OutOfBoundsShape[] {
  const result: OutOfBoundsShape[] = [];
  for (const shape of scene.getAll()) {
    const bb = shape.boundingBox;
    if (
      bb.x < 0 ||
      bb.y < 0 ||
      bb.x + bb.width > pageWidth ||
      bb.y + bb.height > pageHeight
    ) {
      result.push({
        id: shape.id,
        name: shape.name,
        bbox: { ...bb },
      });
    }
  }
  return result;
}
