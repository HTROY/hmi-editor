import { VariableManager } from "../variables/VariableManager";
import type { ScriptDef, ExecutionResult } from "./types";

// ============================================================
// ScriptEngine — 脚本引擎
// 使用 Function 构造器安全执行用户 JavaScript 逻辑
// 提供 sandbox API 供脚本调用
// ============================================================

export interface ScriptSandbox {
  /** 获取变量当前值 */
  getVar: (id: string) => number | boolean | undefined;
  /** 设置变量值 */
  setVar: (id: string, value: number | boolean) => void;
  /** 输出日志 */
  log: (...args: unknown[]) => void;
  /** 告警 */
  warn: (...args: unknown[]) => void;
  /** 获取当前时间戳 */
  now: () => number;
  /** 延迟 */
  sleep: (ms: number) => Promise<void>;
  /** 数学工具 */
  Math: typeof Math;
  /** JSON */
  JSON: typeof JSON;
}

export class ScriptEngine {
  private scripts: Map<string, ScriptDef> = new Map();
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private running = false;

  private varManager: VariableManager;
  private unsubVar: (() => void) | null = null;

  private listeners: Set<(id: string, result: ExecutionResult) => void> =
    new Set();

  constructor(varManager: VariableManager) {
    this.varManager = varManager;
  }

  onResult(cb: (id: string, result: ExecutionResult) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ---- 脚本管理 ----

  define(def: ScriptDef): void {
    this.scripts.set(def.id, def);
  }
  remove(id: string): void {
    this.stopScript(id);
    this.scripts.delete(id);
  }
  get(id: string): ScriptDef | undefined {
    return this.scripts.get(id);
  }
  getAll(): ScriptDef[] {
    return Array.from(this.scripts.values());
  }

  // ---- 引擎控制 ----

  start(): void {
    if (this.running) return;
    this.running = true;

    // 启动所有启用的脚本
    for (const def of this.scripts.values()) {
      if (def.enabled) this.startScript(def);
    }
  }

  stop(): void {
    this.running = false;
    for (const id of this.timers.keys()) this.stopScript(id);
    this.unsubVar?.();
  }

  /** 手动执行脚本 */
  async execute(id: string): Promise<ExecutionResult> {
    const def = this.scripts.get(id);
    if (!def)
      return { success: false, output: "", duration: 0, error: "脚本不存在" };
    return this.runScript(def);
  }

  /** 启用/禁用脚本 */
  setEnabled(id: string, enabled: boolean): void {
    const def = this.scripts.get(id);
    if (!def) return;
    def.enabled = enabled;
    if (enabled && this.running) this.startScript(def);
    else this.stopScript(id);
  }

  /** 更新脚本代码 */
  updateCode(id: string, code: string): void {
    const def = this.scripts.get(id);
    if (!def) return;
    const wasRunning = def.enabled && this.running;
    if (wasRunning) this.stopScript(id);
    def.code = code;
    def.lastError = null;
    if (wasRunning) this.startScript(def);
  }

  // ---- 内部 ----

  private createSandbox(id: string): ScriptSandbox {
    return {
      getVar: (vid) => this.varManager.getValue(vid)?.value,
      setVar: (vid, val) => this.varManager.setValue(vid, val),
      log: (...args) => console.log("[Script:" + id + "]", ...args),
      warn: (...args) => console.warn("[Script:" + id + "]", ...args),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      Math,
      JSON,
    };
  }

  private runScript(def: ScriptDef): ExecutionResult {
    const start = Date.now();
    try {
      const sandbox = this.createSandbox(def.id);
      // 提取函数参数名
      const fn = new Function("sandbox", def.code);
      // 同步执行
      const result = fn(sandbox);
      const duration = Date.now() - start;
      const output = result !== undefined ? String(result) : "OK";
      def.lastRun = Date.now();
      def.lastError = null;
      const execResult: ExecutionResult = {
        success: true,
        output,
        duration,
        error: null,
      };
      this.emit(def.id, execResult);
      return execResult;
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      def.lastRun = Date.now();
      def.lastError = message;
      const execResult: ExecutionResult = {
        success: false,
        output: "",
        duration,
        error: message,
      };
      this.emit(def.id, execResult);
      return execResult;
    }
  }

  private async runScriptAsync(def: ScriptDef): Promise<void> {
    this.runScript(def);
  }

  private startScript(def: ScriptDef): void {
    this.stopScript(def.id);

    switch (def.trigger) {
      case "startup":
        this.runScriptAsync(def);
        break;
      case "cycle":
        if (def.triggerConfig?.intervalMs) {
          const timer = setInterval(
            () => this.runScriptAsync(def),
            def.triggerConfig.intervalMs
          );
          this.timers.set(def.id, timer);
        }
        break;
      case "manual":
        // 手动触发，不自动执行
        break;
    }
  }

  private stopScript(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(id);
    }
  }

  private emit(id: string, result: ExecutionResult): void {
    this.listeners.forEach((cb) => cb(id, result));
  }

  // ---- 预设 ----

  loadPresets(): void {
    this.define({
      id: "script_demo_cycle",
      name: "周期打印变量",
      description: "每5秒打印所有变量值",
      trigger: "cycle",
      triggerConfig: { intervalMs: 5000 },
      code: "var vals = [];\nfor (var i = 0; i < 10; i++) {\n  var v = sandbox.getVar('STA1_211_IA');\n  if (v !== undefined) vals.push(v);\n}\nsandbox.log('当前值:', vals.slice(0, 3));\nreturn 'OK: ' + vals.length + ' vars';",
      enabled: false,
      lastRun: null,
      lastError: null,
    });
    this.define({
      id: "script_demo_control",
      name: "自动控制风机",
      description: "温度高于28℃时自动开启风机",
      trigger: "cycle",
      triggerConfig: { intervalMs: 10000 },
      code: "var temp = sandbox.getVar('STA1_TEMP_ZONE1');\nsandbox.log('当前温度:', temp);\nif (temp > 28) {\n  sandbox.setVar('STA1_FAN_1_STATUS', 1);\n  sandbox.log('温度过高，启动风机');\n  return '风机已启动';\n}\nreturn '温度正常: ' + temp;",
      enabled: false,
      lastRun: null,
      lastError: null,
    });
  }
}
