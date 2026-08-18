import { ShapeBase } from "../ShapeBase";
import { baseBindableProps } from "../bindable";
import type { ShapeCapability } from "../capability";
import type { ShapeProps, Point } from "../../types";

// ============================================================
// MetroTransformer — 变压器
// 地铁供电系统单线图中的变压器符号（两个嵌套圆 + 电压等级标注）
// ============================================================

export interface MetroTransformerProps extends ShapeProps {
  /** 一次侧电压 */
  primaryVoltage: string;
  /** 二次侧电压 */
  secondaryVoltage: string;
  /** 额定容量 */
  ratedPower: string;
  /** 是否带电 */
  energized: boolean;
  /** 线圈绕组数: 2 | 3 */
  windingCount: number;
}

export class MetroTransformer extends ShapeBase {
  primaryVoltage: string;
  secondaryVoltage: string;
  ratedPower: string;
  energized: boolean;
  windingCount: number;

  constructor(props?: Partial<MetroTransformerProps>) {
    super("metro-transformer", props);
    this.primaryVoltage = props?.primaryVoltage ?? "35kV";
    this.secondaryVoltage = props?.secondaryVoltage ?? "400V";
    this.ratedPower = props?.ratedPower ?? "2000kVA";
    this.energized = props?.energized ?? true;
    this.windingCount = props?.windingCount ?? 2;
    this.fill = "transparent";
  }

  hitTest(point: Point): boolean {
    const dx = point.x - this.center.x;
    const dy = point.y - this.center.y;
    const rad = -this.rotation * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    return (
      Math.sqrt(localX * localX + localY * localY) <=
      Math.max(this.width, this.height) / 2
    );
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;
    ctx.save();
    ctx.translate(this.center.x, this.center.y);
    ctx.rotate(this.rotation * (Math.PI / 180));
    ctx.globalAlpha = this.opacity;

    const w = this.width;
    const h = this.height;
    const color = this.energized ? this.stroke : "#666666";
    const fillColor = this.energized ? "#2A3A5A" : "#333333";

    // ---- 三个叠放的圆（变压器铁芯符号） ----
    const circleR = w * 0.35;
    const spacing = h * 0.22;

    ctx.strokeStyle = color;
    ctx.lineWidth = this.strokeWidth;
    ctx.fillStyle = fillColor;

    for (let i = -1; i <= 1; i++) {
      const cy = i * spacing;
      ctx.beginPath();
      ctx.arc(0, cy, circleR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // ---- 穿心竖线（线圈示意） ----
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -spacing - circleR);
    ctx.lineTo(0, spacing + circleR);
    ctx.stroke();

    // ---- 电压等级标注 ----
    ctx.fillStyle = this.energized ? "#E0E0E0" : "#666666";
    ctx.font = "10px Microsoft YaHei, sans-serif";
    ctx.textAlign = "center";

    // 一次侧（上方）
    ctx.textBaseline = "bottom";
    ctx.fillText(this.primaryVoltage, 0, -spacing - circleR - 4);

    // 二次侧（下方）
    ctx.textBaseline = "top";
    ctx.fillText(this.secondaryVoltage, 0, spacing + circleR + 4);

    // ---- 容量标注 ----
    ctx.fillStyle = "#888888";
    ctx.font = "8px sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(this.ratedPower, 0, -spacing + circleR + 2);

    ctx.restore();
  }

  clone(): MetroTransformer {
    const c = new MetroTransformer(this.toJSON() as MetroTransformerProps);
    c.primaryVoltage = this.primaryVoltage;
    c.secondaryVoltage = this.secondaryVoltage;
    c.ratedPower = this.ratedPower;
    c.energized = this.energized;
    c.windingCount = this.windingCount;
    return c;
  }

  toJSON(): ShapeProps {
    return {
      ...super.toJSON(),
      primaryVoltage: this.primaryVoltage,
      secondaryVoltage: this.secondaryVoltage,
      ratedPower: this.ratedPower,
      energized: this.energized,
      windingCount: this.windingCount,
    };
  }
}

/** 变压器能力条目（ADR-0007 切片 4）：恒等比 + 基础可绑定 */
export const metroTransformerCapability: ShapeCapability = {
  type: "metro-transformer",
  editor: [
    {
      key: "primaryVoltage",
      label: "一次侧",
      kind: "text",
      placeholder: "35kV",
      get: (s) => (s as MetroTransformer).primaryVoltage,
    },
    {
      key: "secondaryVoltage",
      label: "二次侧",
      kind: "text",
      placeholder: "400V",
      get: (s) => (s as MetroTransformer).secondaryVoltage,
    },
    {
      key: "ratedPower",
      label: "容量",
      kind: "text",
      placeholder: "2000kVA",
      get: (s) => (s as MetroTransformer).ratedPower,
    },
    {
      key: "energized",
      label: "带电",
      kind: "boolean",
      get: (s) => (s as MetroTransformer).energized,
    },
  ],
  uniformOnly: true,
  bindableProps: baseBindableProps(),
};
