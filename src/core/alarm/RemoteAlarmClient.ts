// ============================================================
// RemoteAlarmClient — 远端报警/SOE 客户端（F12 ①）
//
// 后端为唯一事实来源：消费 WS 推送（alarm_snapshot / alarm_update /
// soe / alarm_rules / alarm_rules_changed）+ REST 查询/确认。
// 与 AlarmManager 解耦：Manager 只做模式切换与 UI 通知。
// ============================================================

import type { WebSocketClient } from "../io/WebSocketClient";
import type { WsServerEnvelope } from "@hmi/contracts";
import { Emitter } from "../platform/Emitter";
import {
  countUnacknowledged,
  highestSeverityOf,
  sortedRules,
} from "./alarmLogic";
import type {
  AlarmEventType,
  AlarmHistoryQuery,
  AlarmOccurrence,
  AlarmRule,
  AlarmStreamEvent,
  Paged,
  SOEQuery,
  SOERecord,
} from "./types";
import type { AlarmRepository } from "./AlarmRepository";
import { createLogger } from "../platform/logger";

const logger = createLogger("RemoteAlarmClient");

export class RemoteAlarmClient implements AlarmRepository {
  private emitter = new Emitter<void>();

  private apiBaseUrl = "http://localhost:8081";
  private wsUnsub: (() => void) | null = null;
  private wsStatusUnsub: (() => void) | null = null;

  private rules: Map<string, AlarmRule> = new Map();
  private activeOccurrences: AlarmOccurrence[] = [];
  private historyOccurrences: AlarmOccurrence[] = [];
  private historyTotal = 0;
  private soeRecords: SOERecord[] = [];
  private soeTotal = 0;
  private soeSeqSeen = new Set<number>();
  private maxSOE = 10000;

  onChange(cb: () => void): () => void {
    return this.emitter.onChange(cb);
  }

  /** 接入后端：WebSocket 推送 + REST API 地址 */
  setRemote(wsClient: WebSocketClient, apiBaseUrl: string): void {
    this.apiBaseUrl = apiBaseUrl || this.apiBaseUrl;
    this.wsUnsub?.();
    this.wsUnsub = wsClient.onAlarmMessage((msg) =>
      this.handleRemoteMessage(msg)
    );
    this.wsStatusUnsub?.();
    this.wsStatusUnsub = wsClient.subscribe({
      onData: () => {},
      onStatus: (status) => {
        if (status === "connected") {
          this.refreshAll().catch(() => {});
        }
      },
      onError: () => {},
    });
  }

  start(): void {
    this.refreshAll().catch((err) =>
      logger.warn("后端报警数据初始化失败:", err)
    );
  }

  stop(): void {
    this.wsUnsub?.();
    this.wsUnsub = null;
    this.wsStatusUnsub?.();
    this.wsStatusUnsub = null;
  }

  reset(): void {
    this.soeRecords = [];
    this.soeTotal = 0;
    this.soeSeqSeen.clear();
  }

  // ---- 规则 ----

  listRules(): AlarmRule[] {
    return sortedRules(this.rules.values());
  }

  getRule(id: string): AlarmRule | undefined {
    return this.rules.get(id);
  }

  loadPresets(): void {
    // 远端模式下规则以后端为准，不做本地预置
  }

  async saveRule(_rule: AlarmRule): Promise<void> {
    throw new Error("规则管理请在管理端操作");
  }

  async deleteRule(_id: string): Promise<void> {
    throw new Error("规则管理请在管理端操作");
  }

  // ---- 查询 ----

  getActiveAlarms(): AlarmOccurrence[] {
    return this.activeOccurrences;
  }

  getHistoryAlarms(): AlarmOccurrence[] {
    return this.historyOccurrences;
  }

  getHistoryTotal(): number {
    return this.historyTotal;
  }

  getSOERecords(limit = 100): SOERecord[] {
    return this.soeRecords.slice(0, limit);
  }

  getSOETotal(): number {
    return this.soeTotal;
  }

  get unacknowledgedCount(): number {
    return countUnacknowledged(this.activeOccurrences, this.historyOccurrences);
  }

  get highestSeverity(): AlarmOccurrence["severity"] | null {
    return highestSeverityOf(this.activeOccurrences);
  }

  async queryHistory(q: AlarmHistoryQuery = {}): Promise<void> {
    const params = this.buildQuery(q);
    const paged = await this.request<Paged<AlarmOccurrence>>(
      `/api/alarm/history?${params}`
    );
    this.historyOccurrences = paged.items;
    this.historyTotal = paged.total;
    this.emitter.emit();
  }

  async querySOE(q: SOEQuery = {}): Promise<void> {
    const params = this.buildQuery(q);
    const paged = await this.request<Paged<SOERecord>>(`/api/soe?${params}`);
    this.soeRecords = paged.items;
    this.soeTotal = paged.total;
    this.emitter.emit();
  }

  async getOccurrenceEvents(occurrenceId: string): Promise<AlarmStreamEvent[]> {
    return this.request<AlarmStreamEvent[]>(
      `/api/alarm/occurrences/${encodeURIComponent(occurrenceId)}/events`
    );
  }

  // ---- 确认 ----

  async acknowledge(alarmId: string, user = "operator"): Promise<void> {
    await this.request("/api/alarm/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: alarmId, user }),
    });
  }

  async acknowledgeAll(user = "operator"): Promise<void> {
    await this.request("/api/alarm/ack-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user }),
    });
  }

  // ---- 内部：REST ----

  private async request<T = unknown>(
    path: string,
    init?: RequestInit
  ): Promise<T> {
    const resp = await fetch(this.apiBaseUrl + path, init);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    return resp.json() as Promise<T>;
  }

  private buildQuery(q: object): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
    }
    return sp.toString();
  }

  private async refreshAll(): Promise<void> {
    await Promise.all([
      this.fetchActive(),
      this.fetchHistory(),
      this.fetchSOE(),
      this.fetchRules(),
    ]);
    this.emitter.emit();
  }

  private async fetchActive(): Promise<void> {
    this.activeOccurrences =
      await this.request<AlarmOccurrence[]>("/api/alarm/active");
    this.emitter.emit();
  }

  private async fetchHistory(): Promise<void> {
    const paged = await this.request<Paged<AlarmOccurrence>>(
      "/api/alarm/history?page=1&pageSize=100"
    );
    this.historyOccurrences = paged.items;
    this.historyTotal = paged.total;
  }

  private async fetchSOE(): Promise<void> {
    const paged = await this.request<Paged<SOERecord>>(
      "/api/soe?page=1&pageSize=50"
    );
    this.soeRecords = paged.items;
    this.soeTotal = paged.total;
    for (const r of paged.items) this.soeSeqSeen.add(r.seq);
  }

  private async fetchRules(): Promise<void> {
    const rules = await this.request<AlarmRule[]>("/api/alarm/rules");
    this.rules.clear();
    for (const r of rules) this.rules.set(r.id, r);
  }

  // ---- 内部：WS ----

  private handleRemoteMessage(msg: WsServerEnvelope): void {
    switch (msg.type) {
      case "alarm_snapshot":
        this.activeOccurrences = msg.data;
        this.emitter.emit();
        break;
      case "alarm_update": {
        const update = msg.data;
        this.applyRemoteUpdate({
          eventType: update.event_type,
          occurrence: update.occurrence,
        });
        this.emitter.emit();
        break;
      }
      case "alarm_rules": {
        const rules = msg.data;
        this.rules.clear();
        for (const r of rules) this.rules.set(r.id, r);
        this.emitter.emit();
        break;
      }
      case "alarm_rules_changed": {
        this.fetchRules()
          .then(() => this.emitter.emit())
          .catch((err) =>
            logger.warn("refresh backend alarm rules failed:", err)
          );
        this.emitter.emit();
        break;
      }
      case "soe": {
        const records = msg.data;
        for (const rec of records) {
          if (this.soeSeqSeen.has(rec.seq)) continue;
          this.soeSeqSeen.add(rec.seq);
          this.soeRecords.unshift(rec);
        }
        this.soeRecords.sort((a, b) => b.seq - a.seq);
        if (this.soeRecords.length > this.maxSOE) {
          this.soeRecords = this.soeRecords.slice(0, this.maxSOE);
        }
        this.soeTotal += records.length;
        this.emitter.emit();
        break;
      }
      default:
        // data/snapshot/config_change/role 不属于报警通道
        break;
    }
  }

  private applyRemoteUpdate(update: {
    eventType: AlarmEventType;
    occurrence: AlarmOccurrence;
  }): void {
    const occ = update.occurrence;
    if (update.eventType === "trigger") {
      if (occ.status === "recovered") {
        this.historyOccurrences = [occ, ...this.historyOccurrences];
      } else {
        this.activeOccurrences = [
          occ,
          ...this.activeOccurrences.filter((o) => o.id !== occ.id),
        ];
      }
      this.historyTotal += 1;
      return;
    }
    if (update.eventType === "ack") {
      this.patchOccurrence(occ);
      return;
    }
    // recover / rule_disabled
    this.activeOccurrences = this.activeOccurrences.filter(
      (o) => o.id !== occ.id
    );
    const idx = this.historyOccurrences.findIndex((o) => o.id === occ.id);
    if (idx >= 0) this.historyOccurrences[idx] = occ;
    else this.historyOccurrences.unshift(occ);
  }

  private patchOccurrence(occ: AlarmOccurrence): void {
    const activeIdx = this.activeOccurrences.findIndex((o) => o.id === occ.id);
    if (activeIdx >= 0) {
      this.activeOccurrences[activeIdx] = occ;
      return;
    }
    const historyIdx = this.historyOccurrences.findIndex(
      (o) => o.id === occ.id
    );
    if (historyIdx >= 0) this.historyOccurrences[historyIdx] = occ;
  }
}
