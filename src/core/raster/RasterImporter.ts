import { ImageShape } from "../shapes";
import type { Point } from "../types";

// ============================================================
// RasterImporter — PNG/JPG 栅格导入（core 层）
// 规则：
// - 仅接受 PNG/JPG（MIME 或扩展名）；
// - 按图片自然像素 1:1 创建图元，默认页面居中；
// - 超过 10MB 由调用方提示后仍可继续。
// ============================================================

export const RASTER_FILE_TYPES = ["image/png", "image/jpeg"] as const;
export const RASTER_EXTENSIONS = [".png", ".jpg", ".jpeg"] as const;
export const RASTER_WARNING_SIZE_BYTES = 10 * 1024 * 1024;

export interface RasterImportOptions {
  pageWidth: number;
  pageHeight: number;
  /** 图元左上角插入位置；缺省为页面居中 */
  position?: Point;
}

export interface RasterImageSize {
  width: number;
  height: number;
}

/** 是否为可导入的 PNG/JPG 文件（按 MIME 或扩展名识别） */
export function isRasterFile(file: { name: string; type: string }): boolean {
  const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
  return (
    (RASTER_FILE_TYPES as readonly string[]).includes(
      file.type.toLowerCase()
    ) || (RASTER_EXTENSIONS as readonly string[]).includes(ext)
  );
}

/** 文件大小是否超过 10MB 警告阈值 */
export function isOverRasterWarningSize(size: number): boolean {
  return size > RASTER_WARNING_SIZE_BYTES;
}

/** 以 1:1 像素尺寸创建栅格图元（src 为 data URL） */
export function createRasterShape(
  src: string,
  width: number,
  height: number,
  x = 0,
  y = 0
): ImageShape {
  return new ImageShape({
    src,
    x,
    y,
    width,
    height,
    name: "图片",
  });
}

/** 读取 data URL 图片的自然尺寸（Image 构造器可注入以便测试） */
export function readRasterImageSize(
  src: string,
  createImage: () => HTMLImageElement = () => new Image()
): Promise<RasterImageSize> {
  return new Promise((resolve, reject) => {
    const img = createImage();
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      } else {
        reject(new Error("无法读取图片尺寸"));
      }
    };
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

/** 1:1 插入时默认页面居中的左上角坐标 */
export function centerRasterPosition(
  width: number,
  height: number,
  pageWidth: number,
  pageHeight: number
): Point {
  return {
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
  };
}

/** data URL → 1:1 栅格图元（默认页面居中） */
export async function rasterDataUrlToImageShape(
  src: string,
  options: RasterImportOptions
): Promise<ImageShape> {
  const { width, height } = await readRasterImageSize(src);
  const position =
    options.position ??
    centerRasterPosition(width, height, options.pageWidth, options.pageHeight);
  return createRasterShape(src, width, height, position.x, position.y);
}
