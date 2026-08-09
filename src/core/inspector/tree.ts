import { SceneGraph } from "../scene/SceneGraph";
import { ShapeBase } from "../shapes/ShapeBase";
import { GroupShape } from "../shapes/GroupShape";

// ============================================================
// tree.ts — 图元树：当前页全部图元的层级视图数据与路径寻址
// 顶层按 z 序从最上层到最下层，组内子图元递归展开、同样从最上层排起。
// ============================================================

export type ShapePath = string[];

export interface ShapeTreeNode {
  shape: ShapeBase;
  /** 从场景根到本图元的完整路径（含自身 id） */
  path: ShapePath;
  children: ShapeTreeNode[];
}

export function sortTopmostFirst(shapes: ShapeBase[]): ShapeBase[] {
  return [...shapes].sort((a, b) => b.zIndex - a.zIndex);
}

function toNode(shape: ShapeBase, path: ShapePath): ShapeTreeNode {
  const node: ShapeTreeNode = { shape, path, children: [] };
  if (shape instanceof GroupShape && shape.children.length > 0) {
    node.children = sortTopmostFirst(shape.children).map((child) =>
      toNode(child, [...path, child.id])
    );
  }
  return node;
}

/** 构建当前页的图元树（只读派生数据，不修改场景） */
export function buildShapeTree(scene: SceneGraph): ShapeTreeNode[] {
  return sortTopmostFirst(scene.getAll()).map((shape) =>
    toNode(shape, [shape.id])
  );
}

/** 按路径解析图元；路径任意一环缺失或中间不是组时返回 null */
export function resolveShape(
  scene: SceneGraph,
  path: ShapePath
): ShapeBase | null {
  if (path.length === 0) return null;
  let current: ShapeBase | null = scene.get(path[0]) ?? null;
  if (!current) return null;
  for (let i = 1; i < path.length; i++) {
    if (!(current instanceof GroupShape)) return null;
    const next: ShapeBase | null =
      current.children.find((c) => c.id === path[i]) ?? null;
    if (!next) return null;
    current = next;
  }
  return current;
}

/** 深度优先遍历全部图元（顶层 + 组内递归），回调携带完整路径 */
export function forEachShape(
  scene: SceneGraph,
  cb: (shape: ShapeBase, path: ShapePath) => void
): void {
  const walk = (shape: ShapeBase, path: ShapePath) => {
    cb(shape, path);
    if (shape instanceof GroupShape) {
      for (const child of shape.children) walk(child, [...path, child.id]);
    }
  };
  for (const shape of scene.getAll()) walk(shape, [shape.id]);
}
