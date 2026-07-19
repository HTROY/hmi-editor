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
  points?: Point[];

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
