import { VariableManager } from "../variables/VariableManager";
import type { AlarmDef, AlarmEvent, AlarmSeverity, SOERecord } from "./types";

export class AlarmManager {
  private defs: Map<string, AlarmDef> = new Map();
  private events: AlarmEvent[] = [];
  private history: AlarmEvent[] = [];
  private soeBuffer: SOERecord[] = [];
  private maxSOE = 10000;
  private maxHistory = 50000;
  private unsubVar: (() => void) | null = null;
  private listeners: Set<() => void> = new Set();
  constructor(private varManager: VariableManager) {}
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }
  define(def: AlarmDef): void {
    this.defs.set(def.id, def);
  }
  defineMany(defs: AlarmDef[]): void {
    for (const d of defs) this.define(d);
  }
  removeDef(id: string): void {
    this.defs.delete(id);
  }
  getDef(id: string): AlarmDef | undefined {
    return this.defs.get(id);
  }
  getAllDefs(): AlarmDef[] {
    return Array.from(this.defs.values());
  }
  getDefsByGroup(group: string): AlarmDef[] {
    return this.getAllDefs().filter((d) => d.group === group);
  }
  start(): void {
    this.unsubVar = this.varManager.subscribeAll((variableId, vv) => {
      this.addSOE({
        id: "soe_" + Date.now(),
        variableId,
        value: vv.value,
        quality: vv.quality,
        timestamp: vv.timestamp,
        source: "simulation",
      });
      for (const d of this.defs.values()) {
        if (d.enabled && d.variableId === variableId)
          this.evaluateAlarm(d, vv.value);
      }
    });
  }
  stop(): void {
    this.unsubVar?.();
    this.unsubVar = null;
  }
  private evaluateAlarm(def: AlarmDef, value: number | boolean): void {
    const numVal = typeof value === "number" ? value : value ? 1 : 0;
    let triggered = false;
    switch (def.condition) {
      case "high":
        triggered = numVal > def.threshold;
        break;
      case "low":
        triggered = numVal < def.threshold;
        break;
      case "equal":
        triggered = numVal === def.threshold;
        break;
      case "notEqual":
        triggered = numVal !== def.threshold;
        break;
      case "change":
        triggered = true;
        break;
    }
    const existingIdx = this.events.findIndex(
      (e) =>
        e.alarmId === def.id &&
        (e.status === "active" || e.status === "acknowledged"),
    );
    if (triggered && existingIdx === -1) {
      const ev = this.createEvent(def, numVal);
      this.events.unshift(ev);
      this.history.unshift(ev);
      if (this.history.length > this.maxHistory) this.history.pop();
      this.notify();
    } else if (!triggered && existingIdx !== -1) {
      this.events[existingIdx].status = "recovered";
      this.events[existingIdx].recoveredAt = Date.now();
      this.events = this.events.filter((e) => e.status !== "recovered");
      this.notify();
    }
  }
  private createEvent(def: AlarmDef, value: number | boolean): AlarmEvent {
    const now = Date.now();
    return {
      id: "alarm_" + now,
      alarmId: def.id,
      variableId: def.variableId,
      name: def.name,
      severity: def.severity,
      status: "active",
      message: def.description || def.name + " 越限",
      value,
      threshold: def.threshold,
      group: def.group,
      triggeredAt: now,
      acknowledgedAt: null,
      acknowledgedBy: null,
      recoveredAt: null,
      soeTimestamp: now,
    };
  }
  acknowledge(alarmId: string, user: string = "operator"): void {
    const ev = this.events.find((e) => e.id === alarmId);
    if (ev && ev.status === "active") {
      ev.status = "acknowledged";
      ev.acknowledgedAt = Date.now();
      ev.acknowledgedBy = user;
      this.notify();
    }
  }
  acknowledgeAll(user: string = "operator"): void {
    for (const ev of this.events) {
      if (ev.status === "active") {
        ev.status = "acknowledged";
        ev.acknowledgedAt = Date.now();
        ev.acknowledgedBy = user;
      }
    }
    this.notify();
  }
  getActiveAlarms(): AlarmEvent[] {
    return this.events.filter(
      (e) => e.status === "active" || e.status === "acknowledged",
    );
  }
  getAllAlarms(): AlarmEvent[] {
    return [...this.events, ...this.history.slice(0, 100)];
  }
  get unacknowledgedCount(): number {
    return this.events.filter((e) => e.status === "active").length;
  }
  get highestSeverity(): AlarmSeverity | null {
    if (this.events.some((e) => e.severity === "critical")) return "critical";
    if (this.events.some((e) => e.severity === "major")) return "major";
    if (this.events.some((e) => e.severity === "minor")) return "minor";
    if (this.events.some((e) => e.severity === "warning")) return "warning";
    return null;
  }
  private addSOE(record: SOERecord): void {
    this.soeBuffer.unshift(record);
    if (this.soeBuffer.length > this.maxSOE) this.soeBuffer.pop();
  }
  getSOERecords(limit: number = 100): SOERecord[] {
    return this.soeBuffer.slice(0, limit);
  }
  querySOE(from: number, to: number): SOERecord[] {
    return this.soeBuffer.filter(
      (r) => r.timestamp >= from && r.timestamp <= to,
    );
  }
  loadPresets(): void {
    const presets: AlarmDef[] = [
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
      },
    ];
    for (const p of presets) this.define(p);
  }
}
