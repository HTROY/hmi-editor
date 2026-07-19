import { ShapeBase } from "../ShapeBase";
import type { ShapeProps, Point } from "../../types";

// ============================================================
// MetroFan — 风机
// 地铁 BAS 系统常用图元，4 叶片旋转动画
// ============================================================

export interface MetroFanProps extends ShapeProps {
  /** 当前转速 0-100（0 = 停止） */
  speedPercent: number;
  /** 叶片颜色 */
  bladeColor: string;
  /** 是否在旋转 */
  running: boolean;
  /** 动画角度（由运行时更新） */
  animAngle: number;
}

export class MetroFan extends ShapeBase {
  speedPercent: number;
  bladeColor: string;
  running: boolean;
  animAngle: number;

  constructor(props?: Partial<MetroFanProps>) {
    super("metro-fan", props);
    this.width = props?.width ?? 80;
    this.height = props?.height ?? 80;
    this.speedPercent = props?.speedPercent ?? 0;
    this.bladeColor = props?.bladeColor ?? "#4A90D9";
    this.running = props?.running ?? false;
    this.animAngle = props?.animAngle ?? 0;
    this.fill = "transparent";
    this.strokeWidth = 2;
  }

  hitTest(point: Point): boolean {
    const dx = point.x - this.center.x;
    const dy = point.y - this.center.y;
    const rad = -this.rotation * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    return Math.sqrt(localX * localX + localY * localY) <= Math.max(this.width, this.height) / 2;
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;
    ctx.save();
    ctx.translate(this.center.x, this.center.y);
    ctx.rotate(this.rotation * (Math.PI / 180));
    ctx.globalAlpha = this.opacity;

    const R = Math.min(this.width, this.height) / 2;  // 外半径
    const innerR = R * 0.2;                            // 中心圆半径
    const bladeLen = R * 0.75;                         // 叶片长度
    const bladeW = R * 0.3;                            // 叶片宽度

    // ---- 外圈 ----
    ctx.strokeStyle = this.stroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, R - 4, 0, Math.PI * 2);
    ctx.stroke();

    // ---- 叶片（4片，加上旋转角度） ----
    const baseAngle = this.running ? (this.animAngle || 0) : 0;
    ctx.fillStyle = this.running ? this.bladeColor : "#888888";
    ctx.strokeStyle = this.stroke;
    ctx.lineWidth = 1;

    for (let i = 0; i < 4; i++) {
      const angle = baseAngle + (i * Math.PI) / 2;
      ctx.save();
      ctx.rotate(angle);

      // 叶片路径（类似椭圆）
      ctx.beginPath();
      ctx.ellipse(innerR + bladeLen / 2, 0, bladeLen / 2, bladeW / 2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.restore();
    }

    // ---- 中心圆 ----
    ctx.fillStyle = this.stroke;
    ctx.beginPath();
    ctx.arc(0, 0, innerR + 2, 0, Math.PI * 2);
    ctx.fill();

    // ---- 运行状态文本 ----
    const statusText = this.running ? (this.speedPercent + "%") : "停止";
    ctx.fillStyle = this.running ? "#60E060" : "#888888";
    ctx.font = "10px Microsoft YaHei, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(statusText, 0, R + 14);

    ctx.restore();
  }

  /** 更新动画（由 AnimationEngine 每帧调用） */
  updateAnimation(deltaMs: number): void {
    if (!this.running || this.speedPercent <= 0) return;
    // 转速百分比影响旋转速度
    const speedFactor = this.speedPercent / 100;
    this.animAngle = (this.animAngle ?? 0) + (deltaMs * speedFactor * 0.003);
  }

  clone(): MetroFan {
    const c = new MetroFan(this.toJSON() as MetroFanProps);
    c.speedPercent = this.speedPercent;
    c.bladeColor = this.bladeColor;
    c.running = this.running;
    c.animAngle = this.animAngle;
    return c;
  }

  toJSON(): ShapeProps {
    return {
      ...super.toJSON(),
      speedPercent: this.speedPercent,
      bladeColor: this.bladeColor,
      running: this.running,
      animAngle: this.animAngle ?? 0,
    };
  }
}
