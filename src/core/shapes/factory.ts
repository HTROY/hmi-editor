import type { ShapeType } from "../types";
import { ShapeBase } from "./ShapeBase";
import { RectShape } from "./RectShape";
import { CircleShape } from "./CircleShape";
import { LineShape } from "./LineShape";
import { TextShape } from "./TextShape";
import { PathShape } from "./PathShape";
import { GroupShape } from "./GroupShape";
import { ImageShape } from "./ImageShape";
import {
  MetroBreaker,
  MetroBusBar,
  MetroFan,
  MetroSignal,
  MetroGauge,
  MetroTransformer,
} from "./metro";

/** 图元工厂：根据 type 创建对应实例 */
export function createShape(type: ShapeType, props?: any): ShapeBase {
  switch (type) {
    case "rect":
      return new RectShape(props);
    case "circle":
      return new CircleShape(props);
    case "line":
      return new LineShape(props);
    case "text":
      return new TextShape(props);
    case "path":
      return new PathShape(props);
    case "group":
      return new GroupShape(props);
    case "image":
      return new ImageShape(props);
    case "metro-breaker":
      return new MetroBreaker(props);
    case "metro-busbar":
      return new MetroBusBar(props);
    case "metro-fan":
      return new MetroFan(props);
    case "metro-signal":
      return new MetroSignal(props);
    case "metro-gauge":
      return new MetroGauge(props);
    case "metro-transformer":
      return new MetroTransformer(props);
    default:
      console.warn("未知图元类型: " + String(type) + "，使用矩形代替");
      return new RectShape(props);
  }
}
