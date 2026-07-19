import { ShapeBase } from "../ShapeBase";
import type { ShapeProps, Point } from "../../types";

// ============================================================
// MetroSignal — 信号灯
// 地铁 ISCS 中表示设备运行/停止/故障状态的多色指示灯
// ============================================================

export interface MetroSignalProps extends ShapeProps {
  /** 状态: "red" | "green" | "yellow" | "gray" | "blue" */
  signalColor: string;
  /** 是否闪烁 */
  blinking: boolean;
  /** 标签文字 */
  label: string;
  /** 标签位置: "top" | "bottom" | "right" | "left" | "none" */
  labelPosition: string;
}

const SIGNAL_COLORS: Record<
  string,
  { active: string; dim: string; label: string }
> = {
  red: { active: "#FF2020", dim: "#551515", label: "故障" },
  green: { active: "#20E020", dim: "#155515", label: "运行" },
  yellow: { active: "#E0C020", dim: "#554A15", label: "预警" },
  blue: { active: "#2080E0", dim: "#153055", label: "待机" },
  gray: { active: "#888888", dim: "#333333", label: "离线" },
};

export class MetroSignal extends ShapeBase {
  signalColor: string;
  blinking: boolean;
  label: string;
  labelPosition: string;

  // 闪烁状态（由渲染器或动画引擎控制）
  blinkOn: boolean;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(props?: Partial<MetroSignalProps>) {
    super("metro-signal", props);
    this.width = props?.width ?? 40;
    this.height = props?.height ?? 40;
    this.signalColor = props?.signalColor ?? "gray";
    this.blinking = props?.blinking ?? false;
    this.label = props?.label ?? "";
    this.labelPosition = props?.labelPosition ?? "bottom";
    this.blinkOn = true;
    this.fill = "transparent";
    this.strokeWidth = 1;
  }

  get colors(): { active: string; dim: string; label: string } {
    return SIGNAL_COLORS[this.signalColor] ?? SIGNAL_COLORS.gray!;
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

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;
    ctx.save();
    ctx.translate(this.center.x, this.center.y);
    ctx.rotate(this.rotation * (Math.PI / 180));
    ctx.globalAlpha = this.opacity;

    const R = Math.min(this.width, this.height) / 2 - 2;
    const sc = this.colors;
    const showActive = !this.blinking || this.blinkOn;

    // ---- 灯体（圆形 + 边框） ----
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);

    // 渐变填充（LED 效果）
    const gradient = ctx.createRadialGradient(-R * 0.3, -R * 0.3, 1, 0, 0, R);
    if (showActive) {
      gradient.addColorStop(0, "#FFFFFF");
      gradient.addColorStop(0.3, sc.active);
      gradient.addColorStop(1, sc.dim);
    } else {
      gradient.addColorStop(0, sc.dim);
      gradient.addColorStop(1, "#222222");
    }
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.strokeStyle = this.stroke;
    ctx.lineWidth = this.strokeWidth;
    ctx.stroke();

    // ---- 发光效果 ----
    if (showActive && !this.blinking) {
      ctx.shadowColor = sc.active;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.8, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.05)";
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // ---- 标签 ----
    const labelText = this.label || sc.label;
    ctx.fillStyle = showActive ? sc.active : "#666666";
    ctx.font = "11px Microsoft YaHei, sans-serif";
    ctx.textAlign = "center";

    if (this.labelPosition === "bottom") {
      ctx.textBaseline = "top";
      ctx.fillText(labelText, 0, R + 6);
    } else if (this.labelPosition === "top") {
      ctx.textBaseline = "bottom";
      ctx.fillText(labelText, 0, -R - 6);
    } else if (this.labelPosition === "right") {
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(labelText, R + 6, 0);
    } else if (this.labelPosition === "left") {
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(labelText, -R - 6, 0);
    }

    ctx.restore();
  }

  setColor(color: string): void {
    this.signalColor = color;
  }

  clone(): MetroSignal {
    const c = new MetroSignal(this.toJSON() as MetroSignalProps);
    c.signalColor = this.signalColor;
    c.blinking = this.blinking;
    c.label = this.label;
    c.labelPosition = this.labelPosition;
    return c;
  }

  toJSON(): ShapeProps {
    return {
      ...super.toJSON(),
      signalColor: this.signalColor,
      blinking: this.blinking,
      label: this.label,
      labelPosition: this.labelPosition,
    };
  }
}
