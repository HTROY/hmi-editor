import type { ShapeBase } from "./ShapeBase";
import type { BindableProp } from "./capability";

// ============================================================
// bindable — 可绑定属性注册表的基础层（ADR-0007 切片 4）
//
// 全部类型共享的基础可绑定属性；fill 因 breaker/fan/signal
// 三类型填充为派生状态，由各自类型条目裁剪。逐类型附加
// （cornerRadius/fontSize/text/speedPercent/value 等）按类型
// 就近定义在各类型模块的能力条目里。
// ============================================================

export function bindableNum(
  get: (s: ShapeBase) => number,
  set: (s: ShapeBase, v: number) => void
): BindableProp {
  return { kind: "number", get, set: (s, v) => set(s, v as number) };
}

export function bindableColor(
  get: (s: ShapeBase) => string,
  set: (s: ShapeBase, v: string) => void
): BindableProp {
  return { kind: "color", get, set: (s, v) => set(s, v as string) };
}

export function bindableBool(
  get: (s: ShapeBase) => boolean,
  set: (s: ShapeBase, v: boolean) => void
): BindableProp {
  return { kind: "boolean", get, set: (s, v) => set(s, v as boolean) };
}

export function bindableStr(
  get: (s: ShapeBase) => string,
  set: (s: ShapeBase, v: string) => void
): BindableProp {
  return { kind: "string", get, set: (s, v) => set(s, v as string) };
}

/** 基础可绑定属性（全部类型共享；fill 由 metro 三类型裁剪） */
export function baseBindableProps(): Record<string, BindableProp> {
  return {
    x: bindableNum(
      (s) => s.x,
      (s, v) => {
        s.x = v;
      }
    ),
    y: bindableNum(
      (s) => s.y,
      (s, v) => {
        s.y = v;
      }
    ),
    width: bindableNum(
      (s) => s.width,
      (s, v) => {
        s.width = v;
      }
    ),
    height: bindableNum(
      (s) => s.height,
      (s, v) => {
        s.height = v;
      }
    ),
    rotation: bindableNum(
      (s) => s.rotation,
      (s, v) => {
        s.rotation = v;
      }
    ),
    opacity: bindableNum(
      (s) => s.opacity,
      (s, v) => {
        s.opacity = v;
      }
    ),
    visible: bindableBool(
      (s) => s.visible,
      (s, v) => {
        s.visible = v;
      }
    ),
    fill: bindableColor(
      (s) => s.fill,
      (s, v) => {
        s.fill = v;
      }
    ),
    stroke: bindableColor(
      (s) => s.stroke,
      (s, v) => {
        s.stroke = v;
      }
    ),
    strokeWidth: bindableNum(
      (s) => s.strokeWidth,
      (s, v) => {
        s.strokeWidth = v;
      }
    ),
  };
}
