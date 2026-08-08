import type { AutosaveSnapshot } from "./types";
import type { AutosaveStore } from "./AutosaveStore";

/** 停止编辑后的防抖保存间隔 */
export const AUTOSAVE_DELAY_MS = 1000;

// ============================================================
// AutosaveController — 自动保存调度器
// 停止编辑约 1 秒后写入本地存储；flush 用于页面切换/关闭前立即落盘
// ============================================================

export class AutosaveController {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private store: AutosaveStore,
    private delayMs = AUTOSAVE_DELAY_MS
  ) {}

  /** 防抖调度：延迟窗口内多次调用只保存最后一次快照 */
  schedule(build: () => AutosaveSnapshot): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persist(build());
    }, this.delayMs);
  }

  /** 立即保存并取消待执行的防抖任务 */
  flush(build: () => AutosaveSnapshot): void {
    this.cancelTimer();
    void this.persist(build());
  }

  load(): Promise<AutosaveSnapshot | null> {
    return this.store.load();
  }

  clear(): Promise<void> {
    this.cancelTimer();
    return this.store.clear();
  }

  dispose(): void {
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async persist(snapshot: AutosaveSnapshot): Promise<void> {
    try {
      await this.store.save(snapshot);
    } catch {
      // 自动保存失败不应中断编辑；下次调度会重试
    }
  }
}
