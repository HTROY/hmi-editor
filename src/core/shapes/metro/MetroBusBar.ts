import { ShapeBase } from "../ShapeBase";
import { baseBindableProps } from "../bindable";
import type { ShapeCapability } from "../capability";
import type { ShapeProps, Point } from "../../types";

// ============================================================
// MetroBusBar — 母线
// 地铁供电系统单线图中常用的母线，根据电压等级显示不同颜色
// ============================================================

export interface MetroBusBarProps extends ShapeProps {
  /** 电压等级 */
  voltageLevel: string;
  /** 是否带电 */
  energized: boolean;
}

/** 电压等级颜色配置 */
const VOLTAGE_COLORS: Record<
  string,
  { stroke: string; fill: string; label: string }
> = {
  "35kV": { stroke: "#FF6600", fill: "#FF6600", label: "35kV" },
  "10kV": { stroke: "#FF0000", fill: "#FF0000", label: "10kV" },
  "400V": { stroke: "#00AA00", fill: "#00AA00", label: "400V" },
  "220V": { stroke: "#0066FF", fill: "#0066FF", label: "220V" },
  DC1500V: { stroke: "#800080", fill: "#800080", label: "DC1500V" },
  DC750V: { stroke: "#AA00AA", fill: "#AA00AA", label: "DC750V" },
};

export class MetroBusBar extends ShapeBase {
  voltageLevel: string;
  energized: boolean;

  constructor(props?: Partial<MetroBusBarProps>) {
    super("metro-busbar", props);
    this.voltageLevel = props?.voltageLevel ?? "400V";
    this.energized = props?.energized ?? true;
    this.fill = "transparent";
    this.strokeWidth = props?.strokeWidth ?? 2;
    this.updateColor();
  }

  private updateColor(): void {
    const vc = VOLTAGE_COLORS[this.voltageLevel];
    if (vc) {
      this.stroke = this.energized ? vc.stroke : "#666666";
    }
  }

  setVoltage(level: string): void {
    this.voltageLevel = level;
    this.updateColor();
  }

  setEnergized(on: boolean): void {
    this.energized = on;
    this.updateColor();
  }

  hitTest(point: Point): boolean {
    const dx = point.x - this.center.x;
    const dy = point.y - this.center.y;
    const rad = -this.rotation * (Math.PI / 180);
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const localX = Math.abs(dx * cos - dy * sin);
    const localY = Math.abs(dx * sin + dy * cos);
    return (
      localX <= this.width / 2 + 4 && localY <= Math.max(this.height / 2, 6)
    );
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;
    ctx.save();
    ctx.translate(this.center.x, this.center.y);
    ctx.rotate(this.rotation * (Math.PI / 180));
    ctx.translate(-this.width / 2, -this.height / 2);
    ctx.globalAlpha = this.opacity;

    this.updateColor();
    const vc = VOLTAGE_COLORS[this.voltageLevel];

    // 母线主体（粗线）
    ctx.strokeStyle = this.stroke;
    ctx.lineWidth = this.height > 2 ? this.height : 4;
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.moveTo(0, this.height / 2);
    ctx.lineTo(this.width, this.height / 2);
    ctx.stroke();

    // 电压等级标签
    if (vc && this.width > 80) {
      ctx.fillStyle = this.energized ? vc.stroke : "#666666";
      ctx.font = "bold 11px Microsoft YaHei, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(
        vc.label + (this.energized ? "" : " (失电)"),
        this.width / 2,
        this.height / 2 - 4
      );
    }

    ctx.restore();
  }

  clone(): MetroBusBar {
    const c = new MetroBusBar(this.toJSON() as MetroBusBarProps);
    c.voltageLevel = this.voltageLevel;
    c.energized = this.energized;
    return c;
  }

  toJSON(): ShapeProps {
    return {
      ...super.toJSON(),
      voltageLevel: this.voltageLevel,
      energized: this.energized,
    };
  }
}

/** 母线能力条目（ADR-0007 切片 4）：恒等比 + 基础可绑定 */
export const metroBusBarCapability: ShapeCapability = {
  type: "metro-busbar",
  editor: [
    {
      key: "voltageLevel",
      label: "电压等级",
      kind: "select",
      options: [
        { value: "35kV", label: "35kV" },
        { value: "10kV", label: "10kV" },
        { value: "400V", label: "400V" },
        { value: "220V", label: "220V" },
        { value: "DC1500V", label: "DC1500V" },
        { value: "DC750V", label: "DC750V" },
      ],
      get: (s) => (s as MetroBusBar).voltageLevel,
    },
    {
      key: "energized",
      label: "带电",
      kind: "boolean",
      get: (s) => (s as MetroBusBar).energized,
    },
  ],
  uniformOnly: true,
  bindableProps: baseBindableProps(),
};
