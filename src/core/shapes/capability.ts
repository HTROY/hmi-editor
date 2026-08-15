import type { ShapeBase } from "./ShapeBase";
import type { ShapeType, ShapeProps, Point, BoundingBox } from "../types";
import type { ResizeHandle, ResizeInput } from "./resizeCore";
import { rectCapability } from "./RectShape";
import { circleCapability } from "./CircleShape";
import { lineCapability } from "./LineShape";
import { polylineCapability } from "./PolylineShape";
import { polygonCapability } from "./PolygonShape";
import { textCapability } from "./TextShape";
import { pathCapability } from "./PathShape";
import { imageCapability } from "./ImageShape";
import { groupCapability } from "./GroupShape";
import { metroBreakerCapability } from "./metro/MetroBreaker";
import { metroBusBarCapability } from "./metro/MetroBusBar";
import { metroFanCapability } from "./metro/MetroFan";
import { metroSignalCapability } from "./metro/MetroSignal";
import { metroGaugeCapability } from "./metro/MetroGauge";
import { metroTransformerCapability } from "./metro/MetroTransformer";

// ============================================================
// capability — 图元能力（Shape Capability，ADR-0007）
//
// 「图元类型 = 行为包」的多态 seam：逐类型行为（缩放规则、
// 点集几何、可绑定属性、检查器描述、动画推进等）收敛于这张
// 类型键控能力表，调用方经 capabilityOf 获取，不再按
// 字符串/instanceof 自行分发。
//
// 编译期穷尽性由 Record<ShapeType, ShapeCapability> 保证：
// 第 16 种图元漏注册条目 = 编译失败；运行期 throw 只作
// as 强转脏数据的最后防线。
//
// 全部 15 个条目按类型就近定义（R3），本文件只汇总。
//   切片 5 → advanceAnimation
//   切片 6 → editor
// ============================================================

export interface ShapeCapability {
  readonly type: ShapeType;
  /** 逐类型 resize 覆盖（已归一化入参）；缺省走共享 boxResize */
  resize?: (
    shape: ShapeBase,
    handle: ResizeHandle,
    pointer: Point,
    input: ResizeInput
  ) => void;
  /** metro 专用图元语义上必须等比缩放 */
  uniformOnly?: boolean;
  /** 绝对点集几何：line（两端点）/ polyline / polygon；其余类型无此字段 */
  points?: PointsGeometry;
  /** props 级逐类型包围盒（line/polyline/polygon；缺省走 x/y/w/h 或组子图元） */
  boundsFromProps?: (props: ShapeProps) => BoundingBox;
  /** 可绑定属性注册表：类型化读写器（切片 4） */
  bindableProps?: Record<string, BindableProp>;
  /** 逐类型动画推进（吸收 AnimationEngine 的 MetroFan 特判）；返回是否发生了视觉变化 */
  advanceAnimation?: (shape: ShapeBase, deltaMs: number) => boolean;
  /** 检查器编辑描述（切片 6 落地） */
  editor?: EditorDescriptor[];
}

/** 绝对点集几何的读写：实例级 get/set 与 props 级 read/write 成对提供 */
export interface PointsGeometry {
  /** 实例读点（返回副本） */
  get(shape: ShapeBase): Point[];
  /** 实例写点 */
  set(shape: ShapeBase, points: Point[]): void;
  /** props 读点（缺失字段按偏移语义兜底为 0,0 / 空数组） */
  read(props: ShapeProps): Point[];
  /** props 写点（返回新 props） */
  write(props: ShapeProps, points: Point[]): ShapeProps;
}

/** 绑定可写入的值（与 mapping.MappedValue 对齐；位掩码映射可产生字符串数组） */
export type BindableValue = string | number | boolean | string[];

export interface BindableProp {
  kind: "number" | "color" | "string" | "boolean";
  get(shape: ShapeBase): BindableValue;
  set(shape: ShapeBase, value: BindableValue): void;
}

/** 检查器编辑描述：PropertyPanel 的 SEM 类型属性段由描述驱动渲染（切片 6） */
export interface EditorDescriptor {
  key: string;
  label: string;
  /** boolean 行的勾选框文案 */
  caption?: string;
  kind:
    | "number"
    | "text"
    | "textarea"
    | "color"
    | "boolean"
    | "select"
    | "range"
    | "readonly";
  /** number/range 的取值域 */
  min?: number;
  max?: number;
  /** range/readonly 的显示后缀（如 %） */
  unit?: string;
  /** select 选项 */
  options?: { value: string; label: string }[];
  /** text 占位符 */
  placeholder?: string;
  /** 是否带绑定端子（仅注册表内属性可绑定） */
  bindable?: boolean;
  /** 联动写（如风机停转清零转速）：经面板 setProp 触发，与手改同走撤销记录 */
  sideEffects?: (
    shape: ShapeBase,
    value: BindableValue,
    setProp: (key: string, v: BindableValue) => void
  ) => void;
  /** 读取显示值；写入统一经面板 setProp → store → applyProps（保留逐类型联动语义） */
  get(shape: ShapeBase): BindableValue;
}

/** 图元能力表：全部 15 类型，条目按类型就近定义 */
export const shapeCapabilities: Record<ShapeType, ShapeCapability> = {
  rect: rectCapability,
  circle: circleCapability,
  line: lineCapability,
  polyline: polylineCapability,
  polygon: polygonCapability,
  text: textCapability,
  path: pathCapability,
  image: imageCapability,
  group: groupCapability,
  "metro-breaker": metroBreakerCapability,
  "metro-busbar": metroBusBarCapability,
  "metro-fan": metroFanCapability,
  "metro-signal": metroSignalCapability,
  "metro-gauge": metroGaugeCapability,
  "metro-transformer": metroTransformerCapability,
};

/** 获取图元类型的能力条目；接受实例或类型字符串。未知类型抛错（防御脏数据） */
export function capabilityOf(
  shapeOrType: ShapeBase | ShapeType
): ShapeCapability {
  const type =
    typeof shapeOrType === "string" ? shapeOrType : shapeOrType.type;
  const cap = shapeCapabilities[type];
  if (!cap) {
    throw new Error("图元类型缺少能力条目: " + String(type));
  }
  return cap;
}