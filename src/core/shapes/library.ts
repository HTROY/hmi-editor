import type { BoundingBox, ShapeProps } from "../types";
import { createShape } from "./factory";
import { generateId, ShapeBase } from "./ShapeBase";
import { capabilityOf } from "./capability";
import { unavailableCanvasFactory } from "../platform/defaults";
import type { CanvasFactory } from "../platform/ports";

// ============================================================
// library.ts — 图元库（自定义图元）核心逻辑
// 库项 = 任意单个图元（含组）的序列化定义，随工程持久化；
// 放置 = 深拷贝副本，与库项不再关联（见 ADR-0005）
// ============================================================

export interface LibraryItem {
  id: string;
  name: string;
  /** 所属自定义分组；缺省表示未分组 */
  groupId?: string;
  /** 库项内容：单个图元（含组）的序列化定义 */
  shape: ShapeProps;
  createdAt: string;
  updatedAt: string;
}

export function generateLibraryId(): string {
  return (
    "lib_" +
    Date.now().toString(36) +
    "_" +
    Math.floor(Math.random() * 0xffff).toString(36)
  );
}

/** 深拷贝图元定义并重新生成全部 id（含子图元） */
export function cloneShapeWithNewIds(props: ShapeProps): ShapeProps {
  const clone = JSON.parse(JSON.stringify(props)) as ShapeProps;
  clone.id = generateId();
  if (Array.isArray(clone.children)) {
    clone.children = clone.children.map((child) => cloneShapeWithNewIds(child));
  }
  return clone;
}

/**
 * 平移图元定义。绝大多数图元由 x/y 定位；
 * 直线/折线/多边形的点集是绝对坐标，需要整体偏移点集；
 * 组的 x/y 是子图元原点，只平移组本身。
 */
export function offsetShapeProps(
  props: ShapeProps,
  dx: number,
  dy: number
): ShapeProps {
  if (dx === 0 && dy === 0) return props;
  const points = capabilityOf(props.type).points;
  if (points) {
    return points.write(
      props,
      points.read(props).map((p) => ({ x: p.x + dx, y: p.y + dy }))
    );
  }
  return { ...props, x: props.x + dx, y: props.y + dy };
}

/** 计算图元定义的包围盒（对点集/子图元递归计算） */
export function getShapeBounds(props: ShapeProps): BoundingBox {
  const own = capabilityOf(props.type).boundsFromProps?.(props);
  if (own) return own;
  const children = props.children ?? [];
  if (children.length > 0) {
    const boxes = children.map(getShapeBounds);
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxX = Math.max(...boxes.map((b) => b.x + b.width));
    const maxY = Math.max(...boxes.map((b) => b.y + b.height));
    return {
      x: props.x + minX,
      y: props.y + minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }
  return { x: props.x, y: props.y, width: props.width, height: props.height };
}

/**
 * 把画布选中图元保存为库项：
 * 单个图元原样保存；多个图元包一层组，子图元坐标归一为组内相对坐标。
 */
export function createLibraryItem(
  shapes: ShapeBase[],
  name: string,
  groupId?: string
): LibraryItem {
  if (shapes.length === 0) {
    throw new Error("没有可保存的图元");
  }
  const now = new Date().toISOString();
  let shape: ShapeProps;
  if (shapes.length === 1) {
    shape = shapes[0].toJSON();
  } else {
    const props = shapes.map((s) => s.toJSON());
    const bounds = props.map(getShapeBounds);
    const minX = Math.min(...bounds.map((b) => b.x));
    const minY = Math.min(...bounds.map((b) => b.y));
    const maxX = Math.max(...bounds.map((b) => b.x + b.width));
    const maxY = Math.max(...bounds.map((b) => b.y + b.height));
    shape = {
      id: generateId(),
      type: "group",
      x: 0,
      y: 0,
      width: maxX - minX,
      height: maxY - minY,
      rotation: 0,
      opacity: 1,
      visible: true,
      locked: false,
      zIndex: 0,
      fill: "#CCCCCC",
      stroke: "#000000",
      strokeWidth: 1,
      dashArray: [],
      name,
      bindings: [],
      animations: [],
      events: [],
      children: props.map((p) =>
        offsetShapeProps(cloneShapeWithNewIds(p), -minX, -minY)
      ),
    };
  }
  return {
    id: generateLibraryId(),
    name,
    groupId,
    shape,
    createdAt: now,
    updatedAt: now,
  };
}

/** 从库项生成放置副本；传入世界坐标时把包围盒中心对齐到该点 */
export function libraryItemToShape(
  item: LibraryItem,
  x?: number,
  y?: number
): ShapeBase {
  let props = cloneShapeWithNewIds(item.shape);
  if (x !== undefined && y !== undefined) {
    const bounds = getShapeBounds(props);
    props = offsetShapeProps(
      props,
      x - (bounds.x + bounds.width / 2),
      y - (bounds.y + bounds.height / 2)
    );
  }
  return createShape(props.type, props);
}

/**
 * 离屏渲染图元缩略图（库面板与拖拽预览共用）。
 * 画布由注入的 CanvasFactory 创建（浏览器实现见 editor/platform），
 * 核心层不直接创建 DOM 元素。
 */
export function renderShapeThumbnail(
  shape: ShapeProps,
  size = 96,
  canvasFactory: CanvasFactory = unavailableCanvasFactory
): HTMLCanvasElement {
  const canvas = canvasFactory.createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const bounds = getShapeBounds(shape);
  const instance = createShape(shape.type, shape);
  const pad = Math.max(4, size * 0.08);
  const scale = Math.min(
    (size - pad * 2) / Math.max(bounds.width, 1),
    (size - pad * 2) / Math.max(bounds.height, 1)
  );
  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.scale(scale, scale);
  ctx.translate(
    -(bounds.x + bounds.width / 2),
    -(bounds.y + bounds.height / 2)
  );
  instance.render(ctx);
  ctx.restore();
  return canvas;
}
