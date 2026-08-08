import { describe, expect, it } from "vitest";
import { ImageShape, createShape } from "../shapes";
import {
  RASTER_WARNING_SIZE_BYTES,
  centerRasterPosition,
  createRasterShape,
  isOverRasterWarningSize,
  isRasterFile,
  readRasterImageSize,
} from "./RasterImporter";

describe("RasterImporter", () => {
  it("识别 PNG/JPG 文件（MIME 或扩展名）", () => {
    expect(isRasterFile({ name: "icon.png", type: "image/png" })).toBe(true);
    expect(isRasterFile({ name: "photo.jpg", type: "image/jpeg" })).toBe(true);
    expect(isRasterFile({ name: "photo.JPEG", type: "" })).toBe(true);
    expect(isRasterFile({ name: "icon.svg", type: "image/svg+xml" })).toBe(
      false
    );
    expect(isRasterFile({ name: "icon.gif", type: "image/gif" })).toBe(false);
    expect(isRasterFile({ name: "icon.bmp", type: "image/bmp" })).toBe(false);
  });

  it("超过 10MB 触发警告阈值（等于 10MB 不触发）", () => {
    expect(isOverRasterWarningSize(RASTER_WARNING_SIZE_BYTES)).toBe(false);
    expect(isOverRasterWarningSize(RASTER_WARNING_SIZE_BYTES + 1)).toBe(true);
  });

  it("以 1:1 像素尺寸创建栅格图元", () => {
    const shape = createRasterShape(
      "data:image/png;base64,AAAA",
      640,
      480,
      10,
      20
    );
    expect(shape).toBeInstanceOf(ImageShape);
    expect(shape.type).toBe("image");
    expect(shape.src).toBe("data:image/png;base64,AAAA");
    expect(shape.width).toBe(640);
    expect(shape.height).toBe(480);
    expect(shape.x).toBe(10);
    expect(shape.y).toBe(20);
    expect(shape.name).toBe("图片");
  });

  it("栅格图元序列化往返保留图片数据", () => {
    const shape = createRasterShape("data:image/png;base64,AAAA", 320, 200);
    const restored = createShape(shape.type, shape.toJSON()) as ImageShape;
    expect(restored.src).toBe("data:image/png;base64,AAAA");
    expect(restored.width).toBe(320);
    expect(restored.height).toBe(200);
  });

  it("1:1 插入默认页面居中", () => {
    expect(centerRasterPosition(200, 100, 1000, 800)).toEqual({
      x: 400,
      y: 350,
    });
    // 图片大于页面时按中心放置（负坐标，由调用方提示越界）
    expect(centerRasterPosition(2000, 1000, 1000, 800)).toEqual({
      x: -500,
      y: -100,
    });
  });

  it("读取图片自然尺寸（可注入 Image 构造器）", async () => {
    const createFakeImage = () => {
      const img = {
        naturalWidth: 0,
        naturalHeight: 0,
        src: "",
        onload: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => {
        img.naturalWidth = 800;
        img.naturalHeight = 600;
        img.onload?.();
      });
      return img as unknown as HTMLImageElement;
    };
    const size = await readRasterImageSize(
      "data:image/png;base64,AAAA",
      createFakeImage
    );
    expect(size).toEqual({ width: 800, height: 600 });
  });

  it("图片加载失败时拒绝并提示", async () => {
    const createBrokenImage = () => {
      const img = {
        naturalWidth: 0,
        naturalHeight: 0,
        src: "",
        onload: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => img.onerror?.());
      return img as unknown as HTMLImageElement;
    };
    await expect(
      readRasterImageSize("broken", createBrokenImage)
    ).rejects.toThrow("图片加载失败");
  });
});
