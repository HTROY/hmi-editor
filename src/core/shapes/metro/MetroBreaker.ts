import { ShapeBase } from "../ShapeBase";
import { baseBindableProps } from "../bindable";
import type { ShapeCapability } from "../capability";
import type { ShapeProps, Point } from "../../types";

// ============================================================
// MetroBreaker — 断路器 （地铁 ISCS 标准图元）
// 符号：矩形中间一个 "×" 或竖线，分/合状态颜色切换
// ============================================================

export interface MetroBreakerProps extends ShapeProps {
  /** 状态: "open" | "closed" | "tripped" */
  breakerStatus: string;
  /** 是否显示分合标识 */
  showLabel: boolean;
}

export class MetroBreaker extends ShapeBase {
  breakerStatus: string;
  showLabel: boolean;

  // 状态颜色映射
  static STATUS_COLORS: Record<
    string,
    { fill: string; crossColor: string; label: string }
  > = {
    closed: { fill: "#00FF00", crossColor: "#000000", label: "合" },
    open: { fill: "#808080", crossColor: "#FFFFFF", label: "分" },
    tripped: { fill: "#FF0000", crossColor: "#FFFFFF", label: "跳" },
  };

  constructor(props?: Partial<MetroBreakerProps>) {
    super("metro-breaker", props);
    this.breakerStatus = props?.breakerStatus ?? "open";
    this.showLabel = props?.showLabel ?? true;
    this.fill =
      MetroBreaker.STATUS_COLORS[this.breakerStatus]?.fill ?? "#808080";
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

  setStatus(status: string): void {
    this.breakerStatus = status;
    const colors = MetroBreaker.STATUS_COLORS[status];
    if (colors) this.fill = colors.fill;
  }

  /** breakerStatus 走 setStatus（联动状态色），其余属性整体赋值 */
  applyProps(props: Partial<MetroBreakerProps>): void {
    const { breakerStatus, ...rest } = props;
    if (breakerStatus !== undefined) this.setStatus(breakerStatus);
    Object.assign(this, rest);
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;
    ctx.save();
    ctx.translate(this.center.x, this.center.y);
    ctx.rotate(this.rotation * (Math.PI / 180));
    ctx.translate(-this.width / 2, -this.height / 2);
    ctx.globalAlpha = this.opacity;

    const colors =
      MetroBreaker.STATUS_COLORS[this.breakerStatus] ??
      MetroBreaker.STATUS_COLORS.open!;
    const w = this.width;
    const h = this.height;

    // ---- 外壳（矩形） ----
    ctx.fillStyle = colors.fill;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = this.stroke;
    ctx.lineWidth = this.strokeWidth;
    if (this.dashArray.length > 0) ctx.setLineDash(this.dashArray);
    ctx.strokeRect(0, 0, w, h);
    ctx.setLineDash([]);

    // ---- 交叉符号 × ----
    const pad = w * 0.2;
    ctx.strokeStyle = colors.crossColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pad, pad);
    ctx.lineTo(w - pad, h - pad);
    ctx.moveTo(w - pad, pad);
    ctx.lineTo(pad, h - pad);
    ctx.stroke();

    // ---- 状态标签 ----
    if (this.showLabel) {
      ctx.fillStyle = colors.crossColor;
      ctx.font = "bold 11px Microsoft YaHei, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(colors.label, w / 2, h - pad);
    }

    ctx.restore();
  }

  clone(): MetroBreaker {
    const c = new MetroBreaker(this.toJSON() as MetroBreakerProps);
    c.breakerStatus = this.breakerStatus;
    c.showLabel = this.showLabel;
    return c;
  }

  toJSON(): ShapeProps {
    return {
      ...super.toJSON(),
      breakerStatus: this.breakerStatus,
      showLabel: this.showLabel,
    };
  }
}

/** 断路器能力条目（ADR-0007 切片 4）：恒等比；填充为派生状态，不可绑定 */
const metroBreakerBindable = baseBindableProps();
delete metroBreakerBindable.fill;

export const metroBreakerCapability: ShapeCapability = {
  type: "metro-breaker",
  editor: [
    {
      key: "breakerStatus",
      label: "状态",
      kind: "select",
      options: [
        { value: "open", label: "分闸 (灰色)" },
        { value: "closed", label: "合闸 (绿色)" },
        { value: "tripped", label: "跳闸 (红色)" },
      ],
      get: (s) => (s as MetroBreaker).breakerStatus,
    },
    {
      key: "showLabel",
      label: "标签",
      kind: "boolean",
      get: (s) => (s as MetroBreaker).showLabel,
    },
  ],
  uniformOnly: true,
  bindableProps: metroBreakerBindable,
};
