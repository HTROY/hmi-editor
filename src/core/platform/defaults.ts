/**
 * 核心层端口默认实现（全部无 DOM 依赖，可在 Node 中安全使用）。
 * 浏览器专用实现见 src/editor/platform/browserPorts.ts。
 */

import type {
  CanvasFactory,
  ClockPort,
  DownloadPort,
  StoragePort,
} from "./ports";
import { createLogger } from "./logger";

const logger = createLogger("core/platform");

/** 无存储环境（Node/测试）下的空实现 */
export const NOOP_STORAGE: StoragePort = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

/** 未注入下载端口时的兜底：记录警告，避免浏览器外环境抛错 */
export const noopDownload: DownloadPort = {
  download: (filename) => {
    logger.warn("未配置 DownloadPort，已跳过下载:", filename);
  },
};

/** 系统时钟 */
export const systemClock: ClockPort = {
  now: () => Date.now(),
  isoNow: () => new Date().toISOString(),
};

/** 无 DOM 环境下缩略图渲染的兜底：调用即抛出明确错误 */
export const unavailableCanvasFactory: CanvasFactory = {
  createCanvas: () => {
    throw new Error(
      "[core/platform] 当前环境无 DOM，无法创建离屏画布；请注入 CanvasFactory"
    );
  },
};
