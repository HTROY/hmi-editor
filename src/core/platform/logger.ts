// ============================================================
// logger — 统一日志封装（F17）
//
// 核心层与编辑器共用；按级别过滤（debug/info/warn/error），
// 生产环境可在入口（src/main.tsx）调 setLogLevel 收紧输出。
// 零依赖，Node 测试环境安全。
// ============================================================

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = "debug";

/** 全局日志级别；低于该级别的输出被丢弃（debug=10 < info=20 < warn=30 < error=40） */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

function write(level: LogLevel, prefix: string, args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const fn =
    level === "debug"
      ? console.debug
      : level === "info"
        ? console.info
        : level === "warn"
          ? console.warn
          : console.error;
  fn(prefix, ...args);
}

/**
 * 创建带命名空间的 logger：`createLogger("DataBridge").info(...)`
 * 输出形如 `[DataBridge] ...`，便于按模块过滤。
 */
export function createLogger(namespace: string): Logger {
  const prefix = `[${namespace}]`;
  return {
    debug: (...args) => write("debug", prefix, args),
    info: (...args) => write("info", prefix, args),
    warn: (...args) => write("warn", prefix, args),
    error: (...args) => write("error", prefix, args),
  };
}
