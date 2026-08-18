// ============================================================
// Emitter — 最小变更通知器（F12 ③）
//
// 抽取 AlarmManager / Historian / AuthManager / RemoteAuthClient
// 中重复的 `listeners: Set + onChange + notify` 样板：
//   - onChange(cb) 订阅并返回退订函数
//   - emit(payload) 通知全部订阅者
// ============================================================

export class Emitter<T = void> {
  private listeners = new Set<(payload: T) => void>();

  /** 订阅变更；返回退订函数 */
  onChange(cb: (payload: T) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 通知全部订阅者 */
  emit(payload: T): void {
    for (const cb of this.listeners) cb(payload);
  }
}
