import type {
  ShapeId,
  ShapeType,
  ShapeProps,
  Point,
  BoundingBox,
  Binding,
  AnimationDef,
  EventHandler,
  ShapeGradient,
} from "../types";
import { normalizeAnimations } from "../bindings/animation";

// ============================================================
// ShapeBase — 所有图元的基类
// ============================================================

let _nextId = 1000;
export function generateId(): string {
  return "shape_" + ++_nextId;
}

export abstract class ShapeBase {
  id: ShapeId;
  type: ShapeType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  zIndex: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  dashArray: number[];
  name: string;

  fillGradient: ShapeGradient | null;
  strokeGradient: ShapeGradient | null;

  bindings: Binding[];
  animations: AnimationDef[];
  events: EventHandler[];

  constructor(type: ShapeType, props?: Partial<ShapeProps>) {
    this.id = props?.id ?? generateId();
    this.type = type;
    this.x = props?.x ?? 0;
    this.y = props?.y ?? 0;
    this.width = props?.width ?? 120;
    this.height = props?.height ?? 80;
    this.rotation = props?.rotation ?? 0;
    this.opacity = props?.opacity ?? 1;
    this.visible = props?.visible ?? true;
    this.locked = props?.locked ?? false;
    this.zIndex = props?.zIndex ?? 0;
    this.fill = props?.fill ?? "#4A90D9";
    this.stroke = props?.stroke ?? "#333333";
    this.strokeWidth = props?.strokeWidth ?? 2;
    this.dashArray = props?.dashArray ?? [];
    this.name = props?.name ?? type;

    this.fillGradient = props?.fillGradient ?? null;
    this.strokeGradient = props?.strokeGradient ?? null;

    this.bindings = props?.bindings ?? [];
    this.animations = normalizeAnimations(props?.animations);
    this.events = props?.events ?? [];
  }

  /** 包围盒（子类可重写） */
  get boundingBox(): BoundingBox {
    return { x: this.x, y: this.y, width: this.width, height: this.height };
  }

  /** 中心点 */
  get center(): Point {
    return { x: this.x + this.width / 2, y: this.y + this.height / 2 };
  }

  /** 旋转感知的包围盒命中测试（子类可复用） */
  protected hitTestLocalBox(point: Point): boolean {
    const dx = point.x - this.center.x;
    const dy = point.y - this.center.y;
    const rad = -this.rotation * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const localX = dx * cos - dy * sin + this.width / 2;
    const localY = dx * sin + dy * cos + this.height / 2;
    return (
      localX >= 0 &&
      localX <= this.width &&
      localY >= 0 &&
      localY <= this.height
    );
  }

  /** 判断点是否在形状内（子类重写实现精确碰撞） */
  abstract hitTest(point: Point): boolean;

  /** 绘制到 Canvas（子类实现具体渲染） */
  abstract render(ctx: CanvasRenderingContext2D): void;

  /** 克隆 */
  abstract clone(): ShapeBase;

  /** 序列化为普通对象 */
  toJSON(): ShapeProps {
    return {
      id: this.id,
      type: this.type,
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      rotation: this.rotation,
      opacity: this.opacity,
      visible: this.visible,
      locked: this.locked,
      zIndex: this.zIndex,
      fill: this.fill,
      stroke: this.stroke,
      strokeWidth: this.strokeWidth,
      dashArray: [...this.dashArray],
      name: this.name,
      ...(this.fillGradient ? { fillGradient: this.fillGradient } : {}),
      ...(this.strokeGradient ? { strokeGradient: this.strokeGradient } : {}),
      bindings: [...this.bindings],
      animations: [...this.animations],
      events: [...this.events],
    };
  }

  /** 从普通对象恢复 */
  fromJSON(props: ShapeProps): void {
    Object.assign(this, props);
    // 旧工程动画缺少 id/params/bind 时补默认值
    this.animations = normalizeAnimations(this.animations);
  }

  /**
   * 批量应用属性（图元编辑事务的统一写入入口）。
   * 默认整体赋值；需要派生状态/校验的子类可重写
   * （如 MetroBreaker 把 breakerStatus 转为 setStatus 并联动颜色）。
   */
  applyProps(props: Partial<ShapeProps>): void {
    Object.assign(this, props);
  }

  /** 等比缩放几何属性（子类扩展点） */
  scale(sx: number, sy: number): void {
    this.x *= sx;
    this.y *= sy;
    this.width *= sx;
    this.height *= sy;
    const s = Math.min(sx, sy);
    this.strokeWidth *= s;
    this.dashArray = this.dashArray.map((v) => v * s);
  }
}
