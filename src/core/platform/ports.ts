/**
 * 核心层平台端口（框架无关）
 *
 * core/ 只依赖这些接口，不直接触碰 DOM / localStorage / 全局定时器；
 * 浏览器实现位于 src/editor/platform/，Node 测试注入内存实现。
 */

/** 键值存储端口（localStorage 的抽象） */
export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** 文件下载端口（浏览器用 <a download> 触发保存；测试注入记录实现） */
export interface DownloadPort {
  download(
    filename: string,
    content: Blob | Uint8Array,
    mimeType: string
  ): void;
}

/** 时钟端口（默认系统时钟；测试可注入固定时间） */
export interface ClockPort {
  /** 当前 epoch 毫秒 */
  now(): number;
  /** 当前 UTC ISO 字符串 */
  isoNow(): string;
}

/** 离屏画布工厂端口（图元缩略图渲染用；浏览器实现创建真实 <canvas>） */
export interface CanvasFactory {
  createCanvas(width: number, height: number): HTMLCanvasElement;
}
