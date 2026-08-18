// ============================================================
// AlarmRepository — 报警/SOE 数据层接口（F12 ①）
//
// 两种实现：
//   - LocalAlarmEngine  — 本地仿真降级引擎（无后端时使用，语义与后端一致）
//   - RemoteAlarmClient — 消费后端 WS 推送 + REST 查询/确认
//
// AlarmManager 只负责模式切换与 UI 通知，数据操作全部委托给当前
// repository；前端其它代码不直接依赖本接口，只依赖 AlarmManager。
// ============================================================

import type {
  AlarmHistoryQuery,
  AlarmOccurrence,
  AlarmRule,
  AlarmStreamEvent,
  SOEQuery,
  SOERecord,
} from "./types";

export interface AlarmRepository {
  /** 订阅数据变更；返回退订函数 */
  onChange(cb: () => void): () => void;

  // ---- 规则 ----

  listRules(): AlarmRule[];
  getRule(id: string): AlarmRule | undefined;
  loadPresets(): void;
  saveRule(rule: AlarmRule): Promise<void>;
  deleteRule(id: string): Promise<void>;

  // ---- 查询 ----

  getActiveAlarms(): AlarmOccurrence[];
  getHistoryAlarms(): AlarmOccurrence[];
  getHistoryTotal(): number;
  getSOERecords(limit?: number): SOERecord[];
  getSOETotal(): number;
  get unacknowledgedCount(): number;
  get highestSeverity(): AlarmOccurrence["severity"] | null;
  queryHistory(q: AlarmHistoryQuery): Promise<void>;
  querySOE(q: SOEQuery): Promise<void>;
  getOccurrenceEvents(occurrenceId: string): Promise<AlarmStreamEvent[]>;

  // ---- 确认 ----

  acknowledge(alarmId: string, user?: string): Promise<void>;
  acknowledgeAll(user?: string): Promise<void>;

  // ---- 生命周期 ----

  start(): void;
  stop(): void;
  /** 模式切换时清空本实现持有的状态（Manager 调用） */
  reset(): void;
}
