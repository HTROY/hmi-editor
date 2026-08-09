import type { Binding } from "../types";
import type { VariableManager } from "../variables";

// ============================================================
// status.ts — 绑定信号状态（展示层用）
// 状态端子：绿=正常 / 黄=数据不确定 / 红=变量缺失或数据异常
// ============================================================

export type BindingStatusLevel = "ok" | "warn" | "bad";

export interface BindingStatus {
  level: BindingStatusLevel;
  text: string;
}

export function getBindingStatus(
  binding: Binding,
  varManager: VariableManager | null
): BindingStatus {
  const defs = varManager?.getAllDefs() ?? [];
  const vDef = defs.find((v) => v.id === binding.variableId);
  if (!vDef) {
    return { level: "bad", text: "变量缺失" };
  }
  const value = varManager?.getValue(binding.variableId);
  if (!value || value.quality === "bad") {
    return { level: "bad", text: "数据异常" };
  }
  if (value.quality === "uncertain") {
    return { level: "warn", text: "数据不确定" };
  }
  return { level: "ok", text: "正常" };
}
