// ============================================================
// AlarmManager — 报警/SOE 门面（F12 ①）
//
// 只做两件事：
//   1. 模式切换（local 仿真引擎 / remote 后端客户端）
//   2. UI 通知转发
// 数据操作全部委托给当前 AlarmRepository：
//   - local  → LocalAlarmEngine（无后端降级引擎，语义与后端一致）
//   - remote → RemoteAlarmClient（WS 推送 + REST）
// ============================================================

import { VariableManager } from "../variables/VariableManager";
import type { WebSocketClient } from "../io/WebSocketClient";
import { Emitter } from "../platform/Emitter";
import type { AlarmRepository } from "./AlarmRepository";
import { LocalAlarmEngine } from "./LocalAlarmEngine";
import { RemoteAlarmClient } from "./RemoteAlarmClient";
import type {
  AlarmHistoryQuery,
  AlarmOccurrence,
  AlarmRule,
  AlarmStreamEvent,
  SOEQuery,
  SOERecord,
} from "./types";

export type AlarmMode = "local" | "remote";

/**
 * 报警/SOE 数据层门面。
 *
 * - local：仿真降级引擎（无后端时使用，语义与后端一致，UI 需标注“模拟”）
 * - remote：消费后端 WS 推送 + REST 查询/确认（后端为唯一事实来源）
 */
export class AlarmManager {
  private mode: AlarmMode = "local";
  private emitter = new Emitter<void>();
  private localEngine: LocalAlarmEngine;
  private remoteClient: RemoteAlarmClient;
  private repoUnsub: (() => void) | null = null;

  constructor(varManager: VariableManager) {
    this.localEngine = new LocalAlarmEngine(varManager);
    this.remoteClient = new RemoteAlarmClient();
    this.attachRepo(this.localEngine);
  }

  private get repo(): AlarmRepository {
    return this.mode === "remote" ? this.remoteClient : this.localEngine;
  }

  /** 当前 repository 的变更转发到 UI 订阅者 */
  private attachRepo(repo: AlarmRepository): void {
    this.repoUnsub?.();
    this.repoUnsub = repo.onChange(() => this.emitter.emit());
  }

  onChange(cb: () => void): () => void {
    return this.emitter.onChange(cb);
  }

  getMode(): AlarmMode {
    return this.mode;
  }

  setMode(mode: AlarmMode): void {
    if (this.mode === mode) return;
    this.repo.stop();
    this.mode = mode;
    this.attachRepo(this.repo);
    this.repo.reset();
    this.emitter.emit();
  }

  /** 接入后端：WebSocket 推送 + REST API 地址 */
  setRemote(wsClient: WebSocketClient, apiBaseUrl: string): void {
    this.remoteClient.setRemote(wsClient, apiBaseUrl);
  }

  // ---- 生命周期 ----

  start(): void {
    this.repo.start();
  }

  stop(): void {
    this.repo.stop();
  }

  // ---- 规则 ----

  listRules(): AlarmRule[] {
    return this.repo.listRules();
  }

  getRule(id: string): AlarmRule | undefined {
    return this.repo.getRule(id);
  }

  loadPresets(): void {
    this.repo.loadPresets();
  }

  async saveRule(rule: AlarmRule): Promise<void> {
    await this.repo.saveRule(rule);
  }

  async deleteRule(id: string): Promise<void> {
    await this.repo.deleteRule(id);
  }

  // ---- 查询 ----

  getActiveAlarms(): AlarmOccurrence[] {
    return this.repo.getActiveAlarms();
  }

  getHistoryAlarms(): AlarmOccurrence[] {
    return this.repo.getHistoryAlarms();
  }

  getHistoryTotal(): number {
    return this.repo.getHistoryTotal();
  }

  getSOERecords(limit = 100): SOERecord[] {
    return this.repo.getSOERecords(limit);
  }

  getSOETotal(): number {
    return this.repo.getSOETotal();
  }

  get unacknowledgedCount(): number {
    return this.repo.unacknowledgedCount;
  }

  get highestSeverity(): AlarmOccurrence["severity"] | null {
    return this.repo.highestSeverity;
  }

  async queryHistory(q: AlarmHistoryQuery = {}): Promise<void> {
    await this.repo.queryHistory(q);
  }

  async querySOE(q: SOEQuery = {}): Promise<void> {
    await this.repo.querySOE(q);
  }

  async getOccurrenceEvents(occurrenceId: string): Promise<AlarmStreamEvent[]> {
    return this.repo.getOccurrenceEvents(occurrenceId);
  }

  // ---- 确认 ----

  async acknowledge(alarmId: string, user = "operator"): Promise<void> {
    await this.repo.acknowledge(alarmId, user);
  }

  async acknowledgeAll(user = "operator"): Promise<void> {
    await this.repo.acknowledgeAll(user);
  }
}
