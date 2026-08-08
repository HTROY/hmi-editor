import { ShapeBase } from "./ShapeBase";
import type { ShapeProps, Point } from "../types";
import { getPaint } from "./paint";

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
    this.text = props?.text ?? "文本";
    this.fontSize = props?.fontSize ?? 20;
    this.fontFamily = props?.fontFamily ?? "Microsoft YaHei, sans-serif";
    this.textAlign = props?.textAlign ?? "center";
    this.textBaseline = props?.textBaseline ?? "middle";
    this.fill = props?.fill ?? "#000000";
    this.stroke = props?.stroke ?? "transparent";
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
