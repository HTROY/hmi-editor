export type ShapeId = string;

export type ShapeType =
  | "rect"
  | "circle"
  | "line"
  | "text"
  | "polyline"
  | "polygon"
  | "path"
  | "group"
  | "image"
  | "metro-breaker"
  | "metro-busbar"
  | "metro-fan"
  | "metro-signal"
  | "metro-gauge"
  | "metro-transformer";

export interface Point {
  x: number;
  y: number;
}
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 2D 仿射变换矩阵（SVG transform / path 变换共用） */
export interface TransformMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/** 渐变停止点（颜色为 CSS 颜色字符串，含透明度） */
export interface GradientStop {
  offset: number;
  color: string;
}

/**
 * 渐变填充定义（坐标统一为 objectBoundingBox 单位 0..1，
 * SVG 的 userSpaceOnUse 与 gradientTransform 在导入时已折算）
 */
export type ShapeGradient =
  | {
      type: "linear";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      stops: GradientStop[];
    }
  | {
      type: "radial";
      cx: number;
      cy: number;
      r: number;
      fx?: number;
      fy?: number;
      stops: GradientStop[];
    };

export type ValueMapping =
  | { type: "direct" }
  | { type: "enum"; map: Record<string, string> }
  | { type: "range"; from: [number, number]; to: [number, number] }
  | { type: "bitmask"; bits: number[]; states: Record<number, string> }
  | { type: "stateColor" };

export interface Binding {
  variableId: string;
  variableType: "AI" | "DI" | "AO" | "DO";
  targetProp: string;
  mapping: ValueMapping;
  /** 数值型属性是否启用平滑过渡（默认开启，300ms ease-out） */
  smooth?: boolean;
  /** 平滑过渡时长（毫秒，默认 300） */
  smoothMs?: number;
}

export interface EventHandler {
  trigger: "click" | "dblclick" | "mousedown" | "mouseup";
  action: string;
  params: Record<string, unknown>;
}

/** 五类动画的可调参数（按类型取用） */
export interface AnimationParams {
  // blink —— 闪烁
  frequency?: number; // Hz，默认 1
  minOpacity?: number; // 最低不透明度，默认 0.2
  // rotate —— 旋转
  angleSpeed?: number; // 角速度 deg/s，默认 60
  direction?: 1 | -1; // 方向，默认 1（顺时针）
  // move —— 位移
  amplitudeX?: number; // X 振幅 px，默认 20
  amplitudeY?: number; // Y 振幅 px，默认 0
  moveFrequency?: number; // 频率 Hz，默认 1
  phase?: number; // 初相 rad，默认 0
  // scale —— 缩放
  minScale?: number; // 最小缩放，默认 1
  maxScale?: number; // 最大缩放，默认 1.2
  scaleFrequency?: number; // 频率 Hz，默认 1
  // colorShift —— 变色
  hueRange?: number; // 色相摆动范围 deg，默认 180
  hueSpeed?: number; // 色相速度 deg/s，默认 120
}

/** 动画变量控制：复用值映射（ValueMapping）把变量映射为速度/强度/启停 */
export interface AnimationControl {
  variableId: string;
  control: "speed" | "strength" | "enabled";
  mapping: ValueMapping;
}

export interface AnimationDef {
  id: string;
  type: "blink" | "rotate" | "move" | "colorShift" | "scale";
  enabled: boolean;
  /** 速度倍率（0.1~3，默认 1）；变量 speed 控制会再乘一重 */
  speed: number;
  params: AnimationParams;
  /** 绑定变量控制；未绑定时按固定参数循环 */
  bind?: AnimationControl | null;
  /** 旧版字段（已由 bind 取代），加载时归一化 */
  bindVariable?: string;
}

export interface ShapeProps {
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
  bindings: Binding[];
  animations: AnimationDef[];
  events: EventHandler[];

  // 基本图元扩展
  cornerRadius?: number;
  startPoint?: Point;
  endPoint?: Point;
  fontSize?: number;
  fontFamily?: string;
  text?: string;
  textAlign?: CanvasTextAlign;
  textBaseline?: CanvasTextBaseline;
  points?: Point[];
  d?: string;
  children?: ShapeProps[];
  src?: string;
  fillGradient?: ShapeGradient | null;
  strokeGradient?: ShapeGradient | null;

  // 轨道交通图元扩展
  breakerStatus?: string;
  showLabel?: boolean;
  voltageLevel?: string;
  energized?: boolean;
  speedPercent?: number;
  bladeColor?: string;
  running?: boolean;
  animAngle?: number;
  signalColor?: string;
  blinking?: boolean;
  label?: string;
  labelPosition?: string;
  value?: number;
  min?: number;
  max?: number;
  unit?: string;
  tickCount?: number;
  startAngle?: number;
  endAngle?: number;
  primaryVoltage?: string;
  secondaryVoltage?: string;
  ratedPower?: string;
  windingCount?: number;
  status?: string;
}
