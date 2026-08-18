import { ShapeBase } from "./ShapeBase";
import { baseBindableProps } from "./bindable";
import type { ShapeCapability } from "./capability";
import type { ShapeProps, Point } from "../types";

// ============================================================
// ImageShape — 栅格图元：PNG/JPG 等位图，图片数据随工程持久化
// ============================================================

export class ImageShape extends ShapeBase {
  src: string;

  private static imageCache = new Map<string, HTMLImageElement>();
  private loadListeners = new Set<() => void>();

  constructor(props?: Partial<ShapeProps>) {
    super("image", props);
    this.src = props?.src ?? "";
  }

  hitTest(point: Point): boolean {
    return this.hitTestLocalBox(point);
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (!this.visible) return;
    ctx.save();
    ctx.translate(this.x + this.width / 2, this.y + this.height / 2);
    ctx.rotate(this.rotation * (Math.PI / 180));
    ctx.translate(-this.width / 2, -this.height / 2);
    ctx.globalAlpha = this.opacity;

    const img = this.getImage();
    if (img && img.complete && img.naturalWidth > 0) {
      ctx.drawImage(img, 0, 0, this.width, this.height);
    } else {
      // 图片未加载/无数据时绘制占位框
      ctx.fillStyle = "#E8E8E8";
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.strokeStyle = this.stroke;
      ctx.lineWidth = this.strokeWidth;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(0, 0, this.width, this.height);
      if (this.src) {
        ctx.fillStyle = "#999999";
        ctx.font = "12px Microsoft YaHei, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("图片加载中", this.width / 2, this.height / 2);
      }
    }

    ctx.restore();
  }

  /** 注册图片加载完成后的重绘回调（渲染器使用） */
  addLoadListener(cb: () => void): () => void {
    this.loadListeners.add(cb);
    return () => this.loadListeners.delete(cb);
  }

  clone(): ImageShape {
    return new ImageShape(this.toJSON());
  }

  toJSON(): ShapeProps {
    return { ...super.toJSON(), src: this.src };
  }

  private getImage(): HTMLImageElement | null {
    if (!this.src || typeof Image === "undefined") return null;
    let img = ImageShape.imageCache.get(this.src);
    if (!img) {
      img = new Image();
      img.onload = () => {
        for (const cb of this.loadListeners) cb();
      };
      img.src = this.src;
      ImageShape.imageCache.set(this.src, img);
    }
    return img;
  }
}

/** 栅格图元能力条目（ADR-0007 切片 4）：基础可绑定 */
export const imageCapability: ShapeCapability = {
  type: "image",
  editor: [
    {
      key: "src",
      label: "图片",
      kind: "text",
      placeholder: "data:image/png;base64,... 或图片 URL",
      get: (s) => (s as ImageShape).src,
    },
  ],
  bindableProps: baseBindableProps(),
};
