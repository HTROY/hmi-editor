import { ShapeBase } from "./ShapeBase";
import type { ShapeProps, Point } from "../types";

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
    this.textAlign = "center";
    this.textBaseline = "middle";
    this.fill = "#000000";
    this.stroke = "transparent";
  }

  hitTest(point: Point): boolean {
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

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;
    ctx.save();
    ctx.translate(this.center.x, this.center.y);
    ctx.rotate(this.rotation * (Math.PI / 180));
    ctx.globalAlpha = this.opacity;

    ctx.font = this.fontSize + "px " + this.fontFamily;
    ctx.textAlign = this.textAlign;
    ctx.textBaseline = this.textBaseline;
    ctx.fillStyle = this.fill;
    ctx.fillText(this.text, 0, 0);
    ctx.strokeStyle = this.stroke;
    ctx.lineWidth = this.strokeWidth;
    if (this.stroke !== "transparent") {
      ctx.strokeText(this.text, 0, 0);
    }

    ctx.restore();
  }

  clone(): TextShape {
    return new TextShape(this.toJSON());
  }

  toJSON(): ShapeProps {
    return {
      ...super.toJSON(),
      text: this.text,
      fontSize: this.fontSize,
      fontFamily: this.fontFamily,
    };
  }
}
