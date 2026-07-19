import { ShapeBase } from "../ShapeBase";
import type { ShapeProps, Point } from "../../types";

// ============================================================
// MetroGauge — 仪表（指针式）
// 地铁 ISCS 中显示电流、电压、温度等模拟量
// ============================================================

export interface MetroGaugeProps extends ShapeProps {
  /** 当前值 */
  value: number;
  /** 量程 */
  min: number;
  max: number;
  /** 单位 */
  unit: string;
  /** 刻度分割数 */
  tickCount: number;
  /** 起始角度（度） */
  startAngle: number;
  /** 结束角度（度） */
  endAngle: number;
}

export class MetroGauge extends ShapeBase {
  value: number;
  min: number;
  max: number;
  unit: string;
  tickCount: number;
  startAngle: number;
  endAngle: number;

  constructor(props?: Partial<MetroGaugeProps>) {
    super("metro-gauge", props);
    this.width = props?.width ?? 140;
    this.height = props?.height ?? 140;
    this.value = props?.value ?? 0;
    this.min = props?.min ?? 0;
    this.max = props?.max ?? 100;
    this.unit = props?.unit ?? "";
    this.tickCount = props?.tickCount ?? 5;
    this.startAngle = props?.startAngle ?? 225;
    this.endAngle = props?.endAngle ?? 315;
    this.fill = "transparent";
    this.strokeWidth = 1.5;
  }

  hitTest(point: Point): boolean {
    const dx = point.x - this.center.x;
    const dy = point.y - this.center.y;
    const rad = -this.rotation * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    return Math.sqrt(localX * localY) <= Math.max(this.width, this.height) / 2;
  }

  /** 根据值计算指针角度 */
  private getPointerAngle(): number {
    const range = this.max - this.min;
    if (range <= 0) return this.startAngle;
    const ratio = Math.max(0, Math.min(1, (this.value - this.min) / range));
    return this.startAngle + ratio * (this.endAngle - this.startAngle);
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;
    ctx.save();
    ctx.translate(this.center.x, this.center.y);
    ctx.rotate(this.rotation * (Math.PI / 180));
    ctx.globalAlpha = this.opacity;

    const R = Math.min(this.width, this.height) / 2 - 8;
    const startRad = (this.startAngle * Math.PI) / 180;
    const endRad = (this.endAngle * Math.PI) / 180;
    const arcRange = endRad - startRad;

    // ---- 背景弧 ----
    ctx.strokeStyle = "#444444";
    ctx.lineWidth = 8;
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.arc(0, 0, R - 4, startRad, endRad);
    ctx.stroke();

    // ---- 彩色弧（绿色→黄色→红色） ----
    // 绿色段 (0-70%)
    const greenEnd = startRad + arcRange * 0.7;
    ctx.strokeStyle = "#20C020";
    ctx.beginPath();
    ctx.arc(0, 0, R - 4, startRad, greenEnd);
    ctx.stroke();

    // 黄色段 (70-90%)
    const yellowEnd = startRad + arcRange * 0.9;
    ctx.strokeStyle = "#E0C020";
    ctx.beginPath();
    ctx.arc(0, 0, R - 4, greenEnd, yellowEnd);
    ctx.stroke();

    // 红色段 (90-100%)
    ctx.strokeStyle = "#E03030";
    ctx.beginPath();
    ctx.arc(0, 0, R - 4, yellowEnd, endRad);
    ctx.stroke();

    // ---- 刻度 ----
    ctx.strokeStyle = "#888888";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#AAAAAA";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    for (let i = 0; i <= this.tickCount; i++) {
      const ratio = i / this.tickCount;
      const angle = startRad + ratio * arcRange;
      const innerR = R - 12;
      const outerR = R - 4;
      const tickVal = this.min + ratio * (this.max - this.min);

      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * innerR, Math.sin(angle) * innerR);
      ctx.lineTo(Math.cos(angle) * outerR, Math.sin(angle) * outerR);
      ctx.stroke();

      // 刻度标签（只在主要刻度显示）
      if (i % Math.max(1, Math.floor(this.tickCount / 5)) === 0) {
        ctx.fillStyle = "#AAAAAA";
        const labelR = R + 8;
        ctx.fillText(String(tickVal), Math.cos(angle) * labelR, Math.sin(angle) * labelR);
      }
    }

    // ---- 指针 ----
    const ptrAngle = this.getPointerAngle();
    const ptrRad = (ptrAngle * Math.PI) / 180;
    const ptrLen = R - 14;
    const ptrColor = this.value > this.max * 0.9 ? "#E03030" :
                     this.value > this.max * 0.7 ? "#E0C020" : "#4A90D9";

    // 指针线
    ctx.strokeStyle = ptrColor;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(ptrRad) * ptrLen, Math.sin(ptrRad) * ptrLen);
    ctx.stroke();

    // 指针中心圆
    ctx.fillStyle = "#CCCCCC";
    ctx.strokeStyle = "#666666";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // ---- 数值显示 ----
    const displayVal = typeof this.value === "number" ? this.value.toFixed(1) : "0.0";
    ctx.fillStyle = "#FFFFFF";
    ctx.font = "bold 16px Microsoft YaHei, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(displayVal, 0, 6);

    if (this.unit) {
      ctx.fillStyle = "#888888";
      ctx.font = "10px Microsoft YaHei, sans-serif";
      ctx.textBaseline = "top";
      ctx.fillText(this.unit, 0, 18);
    }

    ctx.restore();
  }

  clone(): MetroGauge {
    const c = new MetroGauge(this.toJSON() as MetroGaugeProps);
    c.value = this.value;
    c.min = this.min;
    c.max = this.max;
    c.unit = this.unit;
    c.startAngle = this.startAngle;
    c.endAngle = this.endAngle;
    return c;
  }

  toJSON(): ShapeProps {
    return {
      ...super.toJSON(),
      value: this.value,
      min: this.min,
      max: this.max,
      unit: this.unit,
      tickCount: this.tickCount,
      startAngle: this.startAngle,
      endAngle: this.endAngle,
    };
  }
}
