import { ShapeBase } from "./ShapeBase";
import type { ShapeProps, Point } from "../types";
import { getPaint } from "./paint";
import { applyBoxResize } from "./resizeCore";
import type { ResizeHandle, ResizeInput } from "./resizeCore";
import type { ShapeCapability } from "./capability";
import { baseBindableProps, bindableNum, bindableStr } from "./bindable";

// ============================================================
// TextShape — 文本
// ============================================================

export class TextShape extends ShapeBase {
  text: string;
  fontSize: number;
  fontFamily: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;

  constructor(props?: Partial<ShapeProps>) {
    super("text", props);
    this.text = props?.text ?? "双击编辑";
    this.fontSize = props?.fontSize ?? 24;
    this.fontFamily = props?.fontFamily ?? "Microsoft YaHei, sans-serif";
    this.textAlign = props?.textAlign ?? "center";
    this.textBaseline = props?.textBaseline ?? "middle";
    this.fill = props?.fill ?? "#000000";
  }

  hitTest(point: Point): boolean {
    return this.hitTestLocalBox(point);
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;
    ctx.save();
    ctx.translate(this.center.x, this.center.y);
    ctx.rotate(this.rotation * (Math.PI / 180));
    ctx.globalAlpha = this.opacity;

    ctx.font = this.fontSize + "px " + this.fontFamily;
    ctx.textAlign = this.textAlign;
    ctx.textBaseline = this.textBaseline;
    ctx.fillStyle = getPaint(ctx, this, "fill");
    ctx.fillText(this.text, 0, 0);
    ctx.strokeStyle = getPaint(ctx, this, "stroke");
    ctx.lineWidth = this.strokeWidth;
    if (this.stroke !== "transparent") {
      ctx.strokeText(this.text, 0, 0);
    }

    ctx.restore();
  }

  clone(): TextShape {
    return new TextShape(this.toJSON());
  }

  scale(sx: number, sy: number): void {
    super.scale(sx, sy);
    this.fontSize *= Math.min(sx, sy);
  }

  toJSON(): ShapeProps {
    return {
      ...super.toJSON(),
      text: this.text,
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
    };
  }
}

/** 文本的手柄 resize：盒式缩放 + 对角锚点字号联动（能力条目，ADR-0007 切片 2） */
function applyTextResize(
  shape: TextShape,
  handle: ResizeHandle,
  pointer: Point,
  o: ResizeInput
): void {
  const r = applyBoxResize(shape, handle, pointer, o);
  if (r.dir.x !== 0 && r.dir.y !== 0) {
    const kFont = Math.min(
      r.target.width / r.bb.width,
      r.target.height / r.bb.height
    );
    shape.fontSize = Math.max(1, shape.fontSize * kFont);
  }
}

export const textCapability: ShapeCapability = {
  type: "text",
  // 窄类型入参经能力接口桥接（strict 逆变）：分发正确性由 capabilityOf 按类型保证
  editor: [
    {
      key: "text",
      label: "文本",
      kind: "text",
      bindable: true,
      get: (s) => (s as TextShape).text,
    },
    {
      key: "fontSize",
      label: "字号",
      kind: "number",
      min: 8,
      max: 200,
      get: (s) => (s as TextShape).fontSize,
    },
  ],
  bindableProps: {
    ...baseBindableProps(),
    text: bindableStr(
      (s) => (s as TextShape).text,
      (s, v) => {
        (s as TextShape).text = v;
      }
    ),
    fontSize: bindableNum(
      (s) => (s as TextShape).fontSize,
      (s, v) => {
        (s as TextShape).fontSize = v;
      }
    ),
  },
  resize: applyTextResize as ShapeCapability["resize"],
};
