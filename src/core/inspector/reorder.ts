import { SceneGraph } from "../scene/SceneGraph";
import { ShapeBase } from "../shapes/ShapeBase";
import { GroupShape } from "../shapes/GroupShape";
import { resolveShape, sortTopmostFirst, type ShapePath } from "./tree";

// ============================================================
// reorder.ts — 同父换序：顶层图元之间、同一组内子图元之间
// 展示顺序始终是「最上层优先」，换序后把 z 序与存储顺序归一。
// ============================================================

/** 返回包含目标图元的兄弟列表（展示顺序：最上层优先）；非法路径返回 null */
export function getSiblingList(
  scene: SceneGraph,
  path: ShapePath
): ShapeBase[] | null {
  if (path.length === 0) return null;
  const parentPath = path.slice(0, -1);
  if (parentPath.length === 0) return sortTopmostFirst(scene.getAll());
  const parent = resolveShape(scene, parentPath);
  if (!(parent instanceof GroupShape)) return null;
  return sortTopmostFirst(parent.children);
}

/**
 * 把目标图元移动到同父兄弟列表的指定展示下标（0 = 最上层），
 * 返回换序前后的展示顺序供历史命令使用；非法路径返回 null。
 */
export function reorderSibling(
  scene: SceneGraph,
  path: ShapePath,
  toIndex: number
): { before: string[]; after: string[] } | null {
  const target = resolveShape(scene, path);
  const siblings = getSiblingList(scene, path);
  if (!target || !siblings) return null;

  const before = siblings.map((s) => s.id);
  const list = [...siblings];
  const from = list.findIndex((s) => s.id === target.id);
  if (from < 0) return null;
  list.splice(from, 1);
  const at = Math.max(0, Math.min(toIndex, list.length));
  list.splice(at, 0, target);

  applySiblingOrder(
    scene,
    path.slice(0, -1),
    list.map((s) => s.id)
  );
  return { before, after: list.map((s) => s.id) };
}

/**
 * 按展示顺序（最上层优先）应用到场景：
 * 顶层图元写入 z 序并重建场景存储顺序；组内子图元重排 children 数组。
 */
export function applySiblingOrder(
  scene: SceneGraph,
  parentPath: ShapePath,
  order: string[]
): void {
  if (parentPath.length === 0) {
    const shapes = order
      .map((id) => scene.get(id))
      .filter((s): s is ShapeBase => !!s);
    shapes.forEach((shape, i) => {
      shape.zIndex = shapes.length - 1 - i;
    });
    scene.clear();
    for (const shape of [...shapes].sort((a, b) => a.zIndex - b.zIndex)) {
      scene.add(shape);
    }
    scene.markDirty();
    return;
  }

  const parent = resolveShape(scene, parentPath);
  if (!(parent instanceof GroupShape)) return;
  const children = order
    .map((id) => parent.children.find((c) => c.id === id))
    .filter((s): s is ShapeBase => !!s);
  children.forEach((child, i) => {
    child.zIndex = children.length - 1 - i;
  });
  parent.children = [...children].sort((a, b) => a.zIndex - b.zIndex);
}
