/**
 * 浏览器平台端口实现（仅供编辑器组合根使用）。
 * 核心层只依赖 src/core/platform/ports.ts 中的接口。
 */

import type {
  CanvasFactory,
  DownloadPort,
  StoragePort,
} from "../../core/platform/ports";
import { NOOP_STORAGE } from "../../core/platform/defaults";

/** 浏览器下载端口：创建 <a download> 触发保存 */
export const browserDownload: DownloadPort = {
  download(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};

/**
 * 浏览器本地存储。延迟解析 localStorage（模块加载时求值会在 Node 测试环境
 * 抛 ReferenceError）；非浏览器环境回退 NOOP_STORAGE，与 core 层默认一致。
 */
function storage(): StoragePort {
  return typeof localStorage !== "undefined" ? localStorage : NOOP_STORAGE;
}

export const browserStorage: StoragePort = {
  getItem: (key) => storage().getItem(key),
  setItem: (key, value) => storage().setItem(key, value),
  removeItem: (key) => storage().removeItem(key),
};

/** 浏览器离屏画布工厂 */
export const browserCanvasFactory: CanvasFactory = {
  createCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
};
