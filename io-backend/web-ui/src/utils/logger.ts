// 管理 UI 统一日志封装（F17）：按级别过滤，生产构建仅保留 warn/error。
// 主编辑器对应实现见 src/core/platform/logger.ts。

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_LEVEL: LogLevel = import.meta.env.PROD ? "warn" : "debug";

let currentLevel: LogLevel = DEFAULT_LEVEL;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
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

/** 创建带命名空间的 logger：`createLogger("AlarmMonitor").warn(...)` */
export function createLogger(namespace: string): Logger {
  const prefix = `[${namespace}]`;
  return {
    debug: (...args) => write("debug", prefix, args),
    info: (...args) => write("info", prefix, args),
    warn: (...args) => write("warn", prefix, args),
    error: (...args) => write("error", prefix, args),
  };
}
