import { capabilityOf } from "../shapes/capability";
import { applyBoxResize, normalizeOptions } from "../shapes/resizeCore";
import type { ResizeHandle, ResizeOptions } from "../shapes/resizeCore";
import type { ShapeBase } from "../shapes/ShapeBase";
import type { Point } from "../types";

// ============================================================
// resize — 图元手柄调整入口（薄入口，ADR-0007 切片 2）
//
// 通用几何机制在 shapes/resizeCore.ts；逐类型行为经图元能力表
// （shapes/capability.ts）分发，条目按类型就近定义（R3）。
// 本文件只保留公共入口 applyResize，其余符号重导出以兼容
// 既有导入方（SvgImporter/groupOps/Renderer/EditorCanvas 等）。
// ============================================================

export * from "../shapes/resizeCore";

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
  const cap = capabilityOf(shape);
  const o = normalizeOptions(options);
  // metro 专用图元语义上必须等比（uniformOnly 取代原 METRO_TYPES 集合）
  if (cap.uniformOnly) o.proportional = true;
  (cap.resize ?? applyBoxResize)(shape, handle, pointer, o);
}
