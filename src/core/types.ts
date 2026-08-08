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
}

export interface EventHandler {
  trigger: "click" | "dblclick" | "mousedown" | "mouseup";
  action: string;
  params: Record<string, any>;
}

export interface AnimationDef {
  type: "blink" | "rotate" | "move" | "colorShift" | "scale";
  enabled: boolean;
  speed: number;
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
