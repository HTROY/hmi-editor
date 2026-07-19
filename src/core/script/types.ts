// ============================================================
// 脚本引擎类型定义
// ============================================================

export type ScriptTrigger = "startup" | "cycle" | "variableChange" | "alarm" | "manual" | "schedule";

export interface ScriptDef {
  id: string;
  name: string;
  description: string;
  trigger: ScriptTrigger;
  triggerConfig?: {
    /** cycle: 周期(ms) */
    intervalMs?: number;
    /** variableChange: 变量ID */
    variableId?: string;
    /** schedule: cron表达式简化版 */
    cron?: string;
  };
  code: string;
  enabled: boolean;
  lastRun: number | null;
  lastError: string | null;
}

export interface ExecutionResult {
  success: boolean;
  output: string;
  duration: number;
  error: string | null;
}
