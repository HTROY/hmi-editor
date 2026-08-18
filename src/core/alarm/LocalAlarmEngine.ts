// ============================================================
// LocalAlarmEngine — 本地仿真报警引擎（F12 ①）
//
// 无后端时的降级引擎：订阅 VariableManager 点位变化，按规则评估
// 触发/滞回/确认延时/恢复/SOE，语义与后端 Rust alarm/engine.rs 对齐
// （用共享 JSON 夹具对拍，见 alarm-fixtures.json）。
// ============================================================

import { VariableManager } from "../variables/VariableManager";
import { Emitter } from "../platform/Emitter";
import {
  conditionTriggered,
  countUnacknowledged,
  highestSeverityOf,
  shouldRecover,
  sortedRules,
  toNumber,
} from "./alarmLogic";
import type {
  AlarmEventType,
  AlarmHistoryQuery,
  AlarmOccurrence,
  AlarmRule,
  AlarmStreamEvent,
  SOEQuery,
  SOERecord,
} from "./types";
import type { AlarmRepository } from "./AlarmRepository";

interface ConfirmEntry {
  since: number;
  rule: AlarmRule;
}

/** 内置仿真规则（语义与 config.yaml / 后端一致） */
const PRESET_RULES: AlarmRule[] = [
  {
    id: "ALM_IA_OVER",
    variableId: "STA1_211_IA",
    name: "A相过流",
    description: "A相电流超过1600A",
    severity: "major",
    group: "供电/400V",
    condition: "high",
    threshold: 1600,
    enabled: true,
    hysteresis: 0,
    confirmMs: 0,
  },
  {
    id: "ALM_BUS_LOW",
    variableId: "STA1_BUS_VOLTAGE",
    name: "母线欠压",
    description: "母线电压低于350V",
    severity: "critical",
    group: "供电/400V",
    condition: "low",
    threshold: 350,
    enabled: true,
    hysteresis: 0,
    confirmMs: 0,
  },
  {
    id: "ALM_BUS_HIGH",
    variableId: "STA1_BUS_VOLTAGE",
    name: "母线过压",
    description: "母线电压高于450V",
    severity: "major",
    group: "供电/400V",
    condition: "high",
    threshold: 450,
    enabled: true,
    hysteresis: 0,
    confirmMs: 0,
  },
  {
    id: "ALM_FAN_STOP",
    variableId: "STA1_FAN_1_STATUS",
    name: "风机停机",
    description: "1号风机停止运行",
    severity: "minor",
    group: "BAS/环控",
    condition: "equal",
    threshold: 0,
    enabled: true,
    hysteresis: 0,
    confirmMs: 0,
  },
  {
    id: "ALM_TEMP_HIGH",
    variableId: "STA1_TEMP_ZONE1",
    name: "站厅高温",
    description: "站厅温度超过30℃",
    severity: "warning",
    group: "BAS/环控",
    condition: "high",
    threshold: 30,
    enabled: true,
    hysteresis: 0,
    confirmMs: 0,
  },
];

export class LocalAlarmEngine implements AlarmRepository {
  private varManager: VariableManager;
  private emitter = new Emitter<void>();

  private rules: Map<string, AlarmRule> = new Map();
  private activeOccurrences: AlarmOccurrence[] = [];
  private historyOccurrences: AlarmOccurrence[] = [];
  private historyTotal = 0;
  private soeRecords: SOERecord[] = [];
  private soeTotal = 0;
  private maxSOE = 10000;

  private unsubVar: (() => void) | null = null;
  private confirmTimer: ReturnType<typeof setInterval> | null = null;
  private confirmState = new Map<string, ConfirmEntry>();
  private lastValues = new Map<
    string,
    { value: number | boolean; quality: string }
  >();
  private localSoeSeq = 0;
  private occCounter = 0;
  private streamEventCounter = 0;
  private localStreamEvents = new Map<string, AlarmStreamEvent[]>();

  constructor(varManager: VariableManager) {
    this.varManager = varManager;
  }

  onChange(cb: () => void): () => void {
    return this.emitter.onChange(cb);
  }

  // ---- 生命周期 ----

  start(): void {
    if (this.unsubVar) return;
    this.unsubVar = this.varManager.subscribeAll((variableId, vv) => {
      this.onLocalPoint(variableId, vv.value, vv.quality, vv.timestamp);
    });
    this.confirmTimer = setInterval(() => this.tickConfirm(), 100);
  }

  stop(): void {
    this.unsubVar?.();
    this.unsubVar = null;
    if (this.confirmTimer) {
      clearInterval(this.confirmTimer);
      this.confirmTimer = null;
    }
  }

  reset(): void {
    this.activeOccurrences = [];
    this.historyOccurrences = [];
    this.soeRecords = [];
    this.soeTotal = 0;
    this.confirmState.clear();
    this.lastValues.clear();
    this.localStreamEvents.clear();
    this.localSoeSeq = 0;
    this.occCounter = 0;
    this.streamEventCounter = 0;
  }

  // ---- 规则 ----

  listRules(): AlarmRule[] {
    return sortedRules(this.rules.values());
  }

  getRule(id: string): AlarmRule | undefined {
    return this.rules.get(id);
  }

  loadPresets(): void {
    for (const p of PRESET_RULES) this.rules.set(p.id, p);
    this.emitter.emit();
  }

  async saveRule(rule: AlarmRule): Promise<void> {
    this.rules.set(rule.id, rule);
    if (!rule.enabled) this.recoverByRule(rule.id, "规则停用");
    this.emitter.emit();
  }

  async deleteRule(id: string): Promise<void> {
    this.recoverByRule(id, "规则删除");
    this.rules.delete(id);
    this.emitter.emit();
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
    let items = [...this.historyOccurrences].sort(
      (a, b) => b.triggeredAt - a.triggeredAt
    );
    if (q.from) items = items.filter((o) => o.triggeredAt >= q.from!);
    if (q.to) items = items.filter((o) => o.triggeredAt <= q.to!);
    if (q.severity) items = items.filter((o) => o.severity === q.severity);
    if (q.group) items = items.filter((o) => o.group === q.group);
    if (q.variableId)
      items = items.filter((o) => o.variableId === q.variableId);
    if (q.status === "unacknowledged") {
      items = items.filter((o) => o.acknowledgedAt == null);
    } else if (q.status === "acknowledged") {
      items = items.filter((o) => o.acknowledgedAt != null);
    } else if (q.status) {
      items = items.filter((o) => o.status === q.status);
    }
    const page = q.page ?? 1;
    const size = q.pageSize ?? 100;
    this.historyOccurrences = items.slice((page - 1) * size, page * size);
    this.historyTotal = items.length;
    this.emitter.emit();
  }

  async querySOE(q: SOEQuery = {}): Promise<void> {
    let items = [...this.soeRecords].sort((a, b) => b.seq - a.seq);
    if (q.from) items = items.filter((r) => r.receiveTime >= q.from!);
    if (q.to) items = items.filter((r) => r.receiveTime <= q.to!);
    if (q.variableId)
      items = items.filter((r) => r.variableId === q.variableId);
    if (q.quality) items = items.filter((r) => r.quality === q.quality);
    const page = q.page ?? 1;
    const size = q.pageSize ?? 100;
    this.soeRecords = items.slice((page - 1) * size, page * size);
    this.soeTotal = items.length;
    this.emitter.emit();
  }

  async getOccurrenceEvents(occurrenceId: string): Promise<AlarmStreamEvent[]> {
    return this.localStreamEvents.get(occurrenceId) ?? [];
  }

  // ---- 确认 ----

  async acknowledge(alarmId: string, user = "operator"): Promise<void> {
    this.localAck(alarmId, user);
    this.emitter.emit();
  }

  async acknowledgeAll(user = "operator"): Promise<void> {
    for (const occ of this.activeOccurrences) {
      if (occ.status === "active") this.applyAck(occ, user);
    }
    for (const occ of this.historyOccurrences) {
      if (occ.status === "recovered" && occ.acknowledgedAt == null)
        this.applyAck(occ, user);
    }
    this.emitter.emit();
  }

  // ---- 内部：引擎 ----

  private onLocalPoint(
    variableId: string,
    value: number | boolean,
    quality: string,
    timestamp: number
  ): void {
    const now = Date.now();
    const prev = this.lastValues.get(variableId);
    const valueChanged = !prev || prev.value !== value;
    const qualityChanged = !prev || prev.quality !== quality;
    if (valueChanged || qualityChanged) {
      this.localSoeSeq += 1;
      this.soeRecords.unshift({
        id: this.localSoeSeq,
        seq: this.localSoeSeq,
        variableId,
        value,
        quality: quality as SOERecord["quality"],
        deviceTime: timestamp,
        receiveTime: now,
        source: "simulation",
      });
      if (this.soeRecords.length > this.maxSOE) this.soeRecords.pop();
      this.soeTotal += 1;
    }
    this.lastValues.set(variableId, { value, quality });
    if (quality !== "good") return;

    const num = toNumber(value);
    for (const rule of this.rules.values()) {
      if (!rule.enabled || rule.variableId !== variableId) continue;
      if (rule.condition === "change") {
        if (valueChanged) this.triggerTransient(rule, value, now);
        continue;
      }
      const triggered = conditionTriggered(rule.condition, num, rule.threshold);
      const active = this.activeOccurrences.some((o) => o.ruleId === rule.id);
      if (triggered && !active) {
        if (rule.confirmMs > 0) {
          if (!this.confirmState.has(rule.id)) {
            this.confirmState.set(rule.id, { since: now, rule });
          }
        } else {
          this.trigger(rule, value, now);
        }
      } else if (shouldRecover(rule, num)) {
        this.confirmState.delete(rule.id);
        this.recoverByRule(rule.id, "恢复正常");
      }
    }
    this.emitter.emit();
  }

  private tickConfirm(): void {
    const now = Date.now();
    for (const [ruleId, entry] of this.confirmState) {
      const rule = entry.rule;
      const last = this.lastValues.get(rule.variableId);
      if (!last || last.quality !== "good") continue;
      const num = toNumber(last.value);
      if (!conditionTriggered(rule.condition, num, rule.threshold)) {
        this.confirmState.delete(ruleId);
        continue;
      }
      if (now - entry.since >= rule.confirmMs) {
        this.confirmState.delete(ruleId);
        this.trigger(rule, last.value, now);
      }
    }
    if (this.confirmState.size > 0) this.emitter.emit();
  }

  private trigger(rule: AlarmRule, value: number | boolean, now: number): void {
    const id = `occ_${now}_${this.occCounter++}`;
    const occurrence: AlarmOccurrence = {
      id,
      ruleId: rule.id,
      variableId: rule.variableId,
      name: rule.name,
      severity: rule.severity,
      group: rule.group,
      message: rule.description || `${rule.name} 越限`,
      value,
      threshold: rule.threshold,
      status: "active",
      triggeredAt: now,
      recoveredAt: null,
      recoveredReason: "",
      acknowledgedAt: null,
      acknowledgedBy: "",
    };
    this.activeOccurrences.unshift(occurrence);
    this.historyTotal += 1;
    this.addStreamEvent(
      occurrence,
      "trigger",
      now,
      "",
      value,
      occurrence.message
    );
  }

  private triggerTransient(
    rule: AlarmRule,
    value: number | boolean,
    now: number
  ): void {
    const id = `occ_${now}_${this.occCounter++}`;
    const occurrence: AlarmOccurrence = {
      id,
      ruleId: rule.id,
      variableId: rule.variableId,
      name: rule.name,
      severity: rule.severity,
      group: rule.group,
      message: rule.description || `${rule.name} 变位`,
      value,
      threshold: rule.threshold,
      status: "recovered",
      triggeredAt: now,
      recoveredAt: now,
      recoveredReason: "瞬时变位",
      acknowledgedAt: null,
      acknowledgedBy: "",
    };
    this.historyOccurrences.unshift(occurrence);
    this.historyTotal += 1;
    this.addStreamEvent(
      occurrence,
      "trigger",
      now,
      "",
      value,
      occurrence.message
    );
  }

  private recoverByRule(ruleId: string, reason: string): void {
    const now = Date.now();
    for (const occ of this.activeOccurrences) {
      if (occ.ruleId !== ruleId) continue;
      this.recover(occ, now, reason);
    }
  }

  private recover(occ: AlarmOccurrence, now: number, reason: string): void {
    this.activeOccurrences = this.activeOccurrences.filter(
      (o) => o.id !== occ.id
    );
    occ.status = "recovered";
    occ.recoveredAt = now;
    occ.recoveredReason = reason;
    const idx = this.historyOccurrences.findIndex((o) => o.id === occ.id);
    if (idx >= 0) this.historyOccurrences[idx] = occ;
    else this.historyOccurrences.unshift(occ);
    const eventType: AlarmEventType =
      reason === "规则停用" || reason === "规则删除"
        ? "rule_disabled"
        : "recover";
    this.addStreamEvent(occ, eventType, now, "", occ.value, reason);
  }

  private localAck(alarmId: string, user: string): void {
    const active = this.activeOccurrences.find((o) => o.id === alarmId);
    if (active && active.status === "active") {
      this.applyAck(active, user);
      return;
    }
    const recovered = this.historyOccurrences.find(
      (o) =>
        o.id === alarmId && o.status === "recovered" && o.acknowledgedAt == null
    );
    if (recovered) this.applyAck(recovered, user);
  }

  private applyAck(occ: AlarmOccurrence, user: string): void {
    occ.status = "acknowledged";
    occ.acknowledgedAt = Date.now();
    occ.acknowledgedBy = user;
    this.addStreamEvent(
      occ,
      "ack",
      Date.now(),
      user,
      occ.value,
      `${user} 确认报警`
    );
  }

  private addStreamEvent(
    occ: AlarmOccurrence,
    eventType: AlarmEventType,
    at: number,
    byUser: string,
    value: number | boolean,
    message: string
  ): void {
    const ev: AlarmStreamEvent = {
      id: ++this.streamEventCounter,
      occurrenceId: occ.id,
      eventType,
      atMs: at,
      byUser,
      value,
      message,
    };
    const list = this.localStreamEvents.get(occ.id) ?? [];
    list.push(ev);
    this.localStreamEvents.set(occ.id, list);
  }
}
