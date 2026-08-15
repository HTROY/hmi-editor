import { SceneGraph } from "../scene/SceneGraph";
import { GroupShape, ShapeBase } from "../shapes";
import { capabilityOf } from "../shapes/capability";
import { generateId } from "../shapes/ShapeBase";
import {
  cloneShapeWithNewIds,
  getShapeBounds,
  offsetShapeProps,
} from "../shapes/library";
import { getRotatedAABB } from "../scene/resize";
import { resolveShape, type ShapePath } from "./tree";
import type { BoundingBox, Point, ShapeProps } from "../types";

// ============================================================
// groupOps.ts — 成组/取消成组几何与子图元世界包围盒
// 成组：子坐标归一为组内相对坐标，组落在原包围盒左上角；
// 取消成组：应用组位移/旋转/透明度/可见性，子图元回到顶层。
// ============================================================

/** 把至少两个图元包成一个组，保持整体世界位置不变 */
export function wrapShapesInGroup(
  shapes: ShapeBase[],
  name = "组"
): GroupShape {
  if (shapes.length < 2) {
    throw new Error("成组至少需要 2 个图元");
  }
  const props = shapes.map((s) => s.toJSON());
  const bounds = props.map(getShapeBounds);
  const minX = Math.min(...bounds.map((b) => b.x));
  const minY = Math.min(...bounds.map((b) => b.y));
  const maxX = Math.max(...bounds.map((b) => b.x + b.width));
  const maxY = Math.max(...bounds.map((b) => b.y + b.height));
  const children = props.map((p) =>
    offsetShapeProps(cloneShapeWithNewIds(p), -minX, -minY)
  );
  return new GroupShape({
    id: generateId(),
    type: "group",
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    zIndex: Math.max(...shapes.map((s) => s.zIndex)),
    fill: "#CCCCCC",
    stroke: "#000000",
    strokeWidth: 1,
    dashArray: [],
    name,
    bindings: [],
    animations: [],
    events: [],
    children,
  });
}

/** 把组展开为顶层子图元：应用位移/旋转/透明度/可见性并重排 z 序 */
export function unwrapGroup(group: GroupShape): ShapeBase[] {
  const rad = (group.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const children = group.children.map((child, i) => {
    const lx = child.x;
    const ly = child.y;
    child.x = group.x + (lx * cos - ly * sin);
    child.y = group.y + (lx * sin + ly * cos);
    child.rotation = child.rotation + group.rotation;
    child.zIndex = group.zIndex + i;
    child.opacity = (child.opacity ?? 1) * group.opacity;
    child.visible = (child.visible ?? true) && group.visible;
    const points = capabilityOf(child).points;
    if (points) {
      points.set(
        child,
        points.get(child).map((p) => transformPoint(p, group, cos, sin))
      );
    }
    return child;
  });
  group.children = [];
  return children;
}

/** 组内相对点变换为世界坐标：先旋转后平移 */
function transformPoint(
  p: Point,
  group: GroupShape,
  cos: number,
  sin: number
): Point {
  return {
    x: group.x + (p.x * cos - p.y * sin),
    y: group.y + (p.x * sin + p.y * cos),
  };
}

export interface UngroupPlan {
  /** 展开后的顶层子图元（已应用组变换） */
  children: ShapeBase[];
  /** 展开前的组完整快照（必须包含子图元，供撤销恢复） */
  groupSnapshot: ShapeProps;
}

/**
 * 规划取消成组：先捕获完整组快照再展开。
 * 顺序不能反——unwrapGroup 会清空 group.children，后取快照将丢失子图元。
 */
export function planUngroup(group: GroupShape): UngroupPlan {
  const groupSnapshot = group.toJSON();
  const children = unwrapGroup(group);
  return { children, groupSnapshot };
}

/** 子图元（含嵌套）在世界坐标系下的屏幕轴对齐包围盒 */
export function getShapeWorldAABB(
  scene: SceneGraph,
  path: ShapePath
): BoundingBox | null {
  const shape = resolveShape(scene, path);
  if (!shape) return null;
  let box = getRotatedAABB(shape);
  for (let i = path.length - 2; i >= 0; i--) {
    const parent = resolveShape(scene, path.slice(0, i + 1));
    if (!(parent instanceof GroupShape)) break;
    box = transformBoxByGroup(box, parent);
  }
  return box;
}

function transformBoxByGroup(box: BoundingBox, group: GroupShape): BoundingBox {
  const rad = (group.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners: Point[] = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of corners) {
    const rx = group.x + (c.x * cos - c.y * sin);
    const ry = group.y + (c.x * sin + c.y * cos);
    minX = Math.min(minX, rx);
    minY = Math.min(minY, ry);
    maxX = Math.max(maxX, rx);
    maxY = Math.max(maxY, ry);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
