import { VariableManager } from "../variables/VariableManager";
import type { WebSocketClient } from "../io/WebSocketClient";
import type {
  AlarmCondition,
  AlarmEventType,
  AlarmHistoryQuery,
  AlarmOccurrence,
  AlarmRule,
  AlarmStreamEvent,
  AlarmUpdateMessage,
  Paged,
  SOEQuery,
  SOERecord,
} from "./types";

export type AlarmMode = "local" | "remote";

interface ConfirmEntry {
  since: number;
  rule: AlarmRule;
}

function conditionTriggered(
  condition: AlarmCondition,
  n: number,
  threshold: number,
): boolean {
  switch (condition) {
    case "high":
      return n > threshold;
    case "low":
      return n < threshold;
    case "equal":
      return n === threshold;
    case "notEqual":
      return n !== threshold;
    case "change":
      return false;
  }
}

function shouldRecover(rule: AlarmRule, n: number): boolean {
  switch (rule.condition) {
    case "high":
      return n <= rule.threshold - rule.hysteresis;
    case "low":
      return n >= rule.threshold + rule.hysteresis;
    case "equal":
      return n !== rule.threshold;
    case "notEqual":
      return n === rule.threshold;
    case "change":
      return false;
  }
}

function toNumber(value: number | boolean): number {
  return typeof value === "number" ? value : value ? 1 : 0;
}

/**
 * 报警/SOE 数据层。
 *
 * - local：仿真降级引擎（无后端时使用，语义与后端一致，UI 需标注“模拟”）
 * - remote：消费后端 WS 推送 + REST 查询/确认（后端为唯一事实来源）
 */
export class AlarmManager {
  private mode: AlarmMode = "local";
  private varManager: VariableManager;
  private wsClient: WebSocketClient | null = null;
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

  // local-only state
  private unsubVar: (() => void) | null = null;
  private confirmTimer: ReturnType<typeof setInterval> | null = null;
  private confirmState = new Map<string, ConfirmEntry>();
  private lastValues = new Map<string, { value: number | boolean; quality: string }>();
  private localSoeSeq = 0;
  private occCounter = 0;
  private streamEventCounter = 0;
  private localStreamEvents = new Map<string, AlarmStreamEvent[]>();

  private listeners: Set<() => void> = new Set();

  constructor(varManager: VariableManager) {
    this.varManager = varManager;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  getMode(): AlarmMode {
    return this.mode;
  }

  setMode(mode: AlarmMode): void {
    if (this.mode === mode) return;
    this.stop();
    this.mode = mode;
    if (mode === "local") {
      this.activeOccurrences = [];
      this.historyOccurrences = [];
      this.soeRecords = [];
      this.confirmState.clear();
      this.lastValues.clear();
      this.localStreamEvents.clear();
    } else {
      this.soeRecords = [];
      this.soeSeqSeen.clear();
    }
    this.notify();
  }

  /** 接入后端：WebSocket 推送 + REST API 地址 */
  setRemote(wsClient: WebSocketClient, apiBaseUrl: string): void {
    this.wsClient = wsClient;
    this.apiBaseUrl = apiBaseUrl || this.apiBaseUrl;
    this.wsUnsub?.();
    this.wsUnsub = wsClient.onAlarmMessage((msg) => this.handleRemoteMessage(msg));
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

  // ---- 生命周期 ----

  start(): void {
    if (this.mode === "remote") {
      this.refreshAll().catch((err) =>
        console.warn("[AlarmManager] 后端报警数据初始化失败:", err),
      );
      return;
    }
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
    this.wsUnsub?.();
    this.wsUnsub = null;
    this.wsStatusUnsub?.();
    this.wsStatusUnsub = null;
  }

  // ---- 规则 ----

  listRules(): AlarmRule[] {
    return Array.from(this.rules.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  getRule(id: string): AlarmRule | undefined {
    return this.rules.get(id);
  }

  loadPresets(): void {
    const presets: AlarmRule[] = [
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
    for (const p of presets) this.rules.set(p.id, p);
    this.notify();
  }

  async saveRule(rule: AlarmRule): Promise<void> {
    if (this.mode === "remote") {
      throw new Error("规则管理请在管理端操作");
    }
    this.rules.set(rule.id, rule);
    if (!rule.enabled) this.recoverByRule(rule.id, "规则停用");
    this.notify();
  }

  async deleteRule(id: string): Promise<void> {
    if (this.mode === "remote") {
      throw new Error("规则管理请在管理端操作");
    }
    this.recoverByRule(id, "规则删除");
    this.rules.delete(id);
    this.notify();
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
    const activeUnacked = this.activeOccurrences.filter((o) => o.status === "active").length;
    const recoveredUnacked = this.historyOccurrences.filter(
      (o) => o.status === "recovered" && o.acknowledgedAt == null,
    ).length;
    return activeUnacked + recoveredUnacked;
  }

  get highestSeverity(): AlarmOccurrence["severity"] | null {
    if (this.activeOccurrences.some((o) => o.severity === "critical")) return "critical";
    if (this.activeOccurrences.some((o) => o.severity === "major")) return "major";
    if (this.activeOccurrences.some((o) => o.severity === "minor")) return "minor";
    if (this.activeOccurrences.some((o) => o.severity === "warning")) return "warning";
    return null;
  }

  async queryHistory(q: AlarmHistoryQuery = {}): Promise<void> {
    if (this.mode === "remote") {
      const params = this.buildQuery(q);
      const paged = await this.request<Paged<AlarmOccurrence>>(`/api/alarm/history?${params}`);
      this.historyOccurrences = paged.items;
      this.historyTotal = paged.total;
      this.notify();
      return;
    }
    let items = [...this.historyOccurrences].sort((a, b) => b.triggeredAt - a.triggeredAt);
    if (q.from) items = items.filter((o) => o.triggeredAt >= q.from!);
    if (q.to) items = items.filter((o) => o.triggeredAt <= q.to!);
    if (q.severity) items = items.filter((o) => o.severity === q.severity);
    if (q.group) items = items.filter((o) => o.group === q.group);
    if (q.variableId) items = items.filter((o) => o.variableId === q.variableId);
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
    this.notify();
  }

  async querySOE(q: SOEQuery = {}): Promise<void> {
    if (this.mode === "remote") {
      const params = this.buildQuery(q);
      const paged = await this.request<Paged<SOERecord>>(`/api/soe?${params}`);
      this.soeRecords = paged.items;
      this.soeTotal = paged.total;
      this.notify();
      return;
    }
    let items = [...this.soeRecords].sort((a, b) => b.seq - a.seq);
    if (q.from) items = items.filter((r) => r.receiveTime >= q.from!);
    if (q.to) items = items.filter((r) => r.receiveTime <= q.to!);
    if (q.variableId) items = items.filter((r) => r.variableId === q.variableId);
    if (q.quality) items = items.filter((r) => r.quality === q.quality);
    const page = q.page ?? 1;
    const size = q.pageSize ?? 100;
    this.soeRecords = items.slice((page - 1) * size, page * size);
    this.soeTotal = items.length;
    this.notify();
  }

  async getOccurrenceEvents(occurrenceId: string): Promise<AlarmStreamEvent[]> {
    if (this.mode === "remote") {
      return this.request<AlarmStreamEvent[]>(
        `/api/alarm/occurrences/${encodeURIComponent(occurrenceId)}/events`,
      );
    }
    return this.localStreamEvents.get(occurrenceId) ?? [];
  }

  // ---- 确认 ----

  async acknowledge(alarmId: string, user = "operator"): Promise<void> {
    if (this.mode === "remote") {
      await this.request("/api/alarm/ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: alarmId, user }),
      });
      return;
    }
    this.localAck(alarmId, user);
    this.notify();
  }

  async acknowledgeAll(user = "operator"): Promise<void> {
    if (this.mode === "remote") {
      await this.request("/api/alarm/ack-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user }),
      });
      return;
    }
    for (const occ of this.activeOccurrences) {
      if (occ.status === "active") this.applyAck(occ, user);
    }
    for (const occ of this.historyOccurrences) {
      if (occ.status === "recovered" && occ.acknowledgedAt == null) this.applyAck(occ, user);
    }
    this.notify();
  }

  // ---- 内部：remote ----

  private async request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
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
    this.notify();
  }

  private async fetchActive(): Promise<void> {
    this.activeOccurrences = await this.request<AlarmOccurrence[]>("/api/alarm/active");
    this.notify();
  }

  private async fetchHistory(): Promise<void> {
    const paged = await this.request<Paged<AlarmOccurrence>>(
      "/api/alarm/history?page=1&pageSize=100",
    );
    this.historyOccurrences = paged.items;
    this.historyTotal = paged.total;
  }

  private async fetchSOE(): Promise<void> {
    const paged = await this.request<Paged<SOERecord>>("/api/soe?page=1&pageSize=50");
    this.soeRecords = paged.items;
    this.soeTotal = paged.total;
    for (const r of paged.items) this.soeSeqSeen.add(r.seq);
  }

  private async fetchRules(): Promise<void> {
    const rules = await this.request<AlarmRule[]>("/api/alarm/rules");
    this.rules.clear();
    for (const r of rules) this.rules.set(r.id, r);
  }

  private handleRemoteMessage(msg: { type: string; data?: any }): void {
    switch (msg.type) {
      case "alarm_snapshot":
        this.activeOccurrences = msg.data ?? [];
        this.notify();
        break;
      case "alarm_update": {
        const update = msg.data as AlarmUpdateMessage;
        this.applyRemoteUpdate({
          eventType: update.event_type,
          occurrence: update.occurrence,
        });
        this.notify();
        break;
      }
      case "alarm_rules": {
        const rules = msg.data as AlarmRule[];
        this.rules.clear();
        for (const r of rules) this.rules.set(r.id, r);
        this.notify();
        break;
      }
      case "alarm_rules_changed": {
        this.fetchRules()
          .then(() => this.notify())
          .catch((err) =>
            console.warn("[AlarmManager] refresh backend alarm rules failed:", err),
          );
        this.notify();
        break;
      }
      case "soe": {
        const records = msg.data as SOERecord[];
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
        this.notify();
        break;
      }
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
    this.activeOccurrences = this.activeOccurrences.filter((o) => o.id !== occ.id);
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
    const historyIdx = this.historyOccurrences.findIndex((o) => o.id === occ.id);
    if (historyIdx >= 0) this.historyOccurrences[historyIdx] = occ;
  }

  // ---- 内部：local 引擎 ----

  private onLocalPoint(
    variableId: string,
    value: number | boolean,
    quality: string,
    timestamp: number,
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
    this.notify();
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
    if (this.confirmState.size > 0) this.notify();
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
    this.addStreamEvent(occurrence, "trigger", now, "", value, occurrence.message);
  }

  private triggerTransient(rule: AlarmRule, value: number | boolean, now: number): void {
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
    this.addStreamEvent(occurrence, "trigger", now, "", value, occurrence.message);
  }

  private recoverByRule(ruleId: string, reason: string): void {
    const now = Date.now();
    for (const occ of this.activeOccurrences) {
      if (occ.ruleId !== ruleId) continue;
      this.recover(occ, now, reason);
    }
  }

  private recover(occ: AlarmOccurrence, now: number, reason: string): void {
    this.activeOccurrences = this.activeOccurrences.filter((o) => o.id !== occ.id);
    occ.status = "recovered";
    occ.recoveredAt = now;
    occ.recoveredReason = reason;
    const idx = this.historyOccurrences.findIndex((o) => o.id === occ.id);
    if (idx >= 0) this.historyOccurrences[idx] = occ;
    else this.historyOccurrences.unshift(occ);
    const eventType: AlarmEventType =
      reason === "规则停用" || reason === "规则删除" ? "rule_disabled" : "recover";
    this.addStreamEvent(occ, eventType, now, "", occ.value, reason);
  }

  private localAck(alarmId: string, user: string): void {
    const active = this.activeOccurrences.find((o) => o.id === alarmId);
    if (active && active.status === "active") {
      this.applyAck(active, user);
      return;
    }
    const recovered = this.historyOccurrences.find(
      (o) => o.id === alarmId && o.status === "recovered" && o.acknowledgedAt == null,
    );
    if (recovered) this.applyAck(recovered, user);
  }

  private applyAck(occ: AlarmOccurrence, user: string): void {
    occ.status = "acknowledged";
    occ.acknowledgedAt = Date.now();
    occ.acknowledgedBy = user;
    this.addStreamEvent(occ, "ack", Date.now(), user, occ.value, `${user} 确认报警`);
  }

  private addStreamEvent(
    occ: AlarmOccurrence,
    eventType: AlarmEventType,
    at: number,
    byUser: string,
    value: number | boolean,
    message: string,
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
