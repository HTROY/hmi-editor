// ============================================================
// alarmLogic — 报警纯判定/汇总函数（F12 ②）
//
// 本地仿真引擎（LocalAlarmEngine）与后端 Rust alarm/engine.rs 是
// 两套平行实现，靠「语义一致」人工保证。这里把纯判定逻辑独立出来，
// 便于单测直接覆盖，也便于用共享 JSON 夹具（F12 ④）对拍。
// Local/Remote 两个 repository 共用的汇总逻辑也放在这里，避免复制。
// ============================================================

import type { AlarmCondition, AlarmOccurrence, AlarmRule } from "./types";

/** 条件是否触发（change 条件永不在此触发，由调用方按变位判定） */
export function conditionTriggered(
  condition: AlarmCondition,
  n: number,
  threshold: number
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

/** 数值是否已离开滞回带、应恢复 */
export function shouldRecover(rule: AlarmRule, n: number): boolean {
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

/** 布尔值归一化为数值（DI/DO 点位） */
export function toNumber(value: number | boolean): number {
  return typeof value === "number" ? value : value ? 1 : 0;
}

// ---- 汇总统计（LocalAlarmEngine 与 RemoteAlarmClient 共用） ----

/**
 * 未确认报警数：活跃未确认（status=active）+ 已恢复未确认
 * （status=recovered 且未 acknowledge）。
 */
export function countUnacknowledged(
  active: AlarmOccurrence[],
  history: AlarmOccurrence[]
): number {
  const activeUnacked = active.filter((o) => o.status === "active").length;
  const recoveredUnacked = history.filter(
    (o) => o.status === "recovered" && o.acknowledgedAt == null
  ).length;
  return activeUnacked + recoveredUnacked;
}

/** 活跃报警中的最高等级（critical > major > minor > warning），无则 null */
export function highestSeverityOf(
  active: AlarmOccurrence[]
): AlarmOccurrence["severity"] | null {
  if (active.some((o) => o.severity === "critical")) return "critical";
  if (active.some((o) => o.severity === "major")) return "major";
  if (active.some((o) => o.severity === "minor")) return "minor";
  if (active.some((o) => o.severity === "warning")) return "warning";
  return null;
}

/** 按 id 升序排列规则 */
export function sortedRules(rules: Iterable<AlarmRule>): AlarmRule[] {
  return Array.from(rules).sort((a, b) => a.id.localeCompare(b.id));
}
