// ============================================================
// storage — 带前缀的浏览器/测试存储封装（F17）
//
// - 统一键前缀（namespace），避免散落的 hmi_* 键
// - JSON 序列化/反序列化自动处理（getJSON/setJSON）
// - 配额/隐私模式写入失败不抛出，返回 false 便于调用方降级
// 实现基于 StoragePort（src/core/platform/ports.ts），
// 浏览器缺省实现延迟解析 localStorage，Node 测试注入内存存储。
// ============================================================

import type { StoragePort } from "./ports";
import { NOOP_STORAGE } from "./defaults";

/** 兼容 connectionConfig/remote 的旧 StorageLike 形态（removeItem 可选） */
export type StorageLike = Pick<StoragePort, "getItem" | "setItem"> & {
  removeItem?(key: string): void;
};

export interface SafeStorage {
  /** 读取原始字符串；键为 prefix + key */
  get(key: string): string | null;
  /** 写入原始字符串；配额/隐私模式失败返回 false（不抛出） */
  set(key: string, value: string): boolean;
  /** 删除 */
  remove(key: string): void;
  /** JSON 读取；缺失/解析失败返回 null */
  getJSON<T>(key: string): T | null;
  /** JSON 写入；序列化/配额失败返回 false */
  setJSON(key: string, value: unknown): boolean;
}

/** 浏览器缺省存储：延迟解析 localStorage（模块加载时求值会在 Node 抛错） */
function defaultBacking(): StorageLike {
  return typeof localStorage !== "undefined" ? localStorage : NOOP_STORAGE;
}

/**
 * 创建带前缀的安全存储。prefix 直接拼在键名前：
 * `createStorage("hmi.").get("leftPanelWidth")` → 键 `hmi.leftPanelWidth`。
 */
export function createStorage(
  prefix: string,
  backing?: StorageLike
): SafeStorage {
  const store: StorageLike = backing ?? defaultBacking();
  const key = (name: string): string => prefix + name;

  return {
    get: (name) => {
      try {
        return store.getItem(key(name));
      } catch {
        return null;
      }
    },
    set: (name, value) => {
      try {
        store.setItem(key(name), value);
        return true;
      } catch {
        // 配额超限 / 隐私模式等：调用方决定是否降级
        return false;
      }
    },
    remove: (name) => {
      try {
        store.removeItem?.(key(name));
      } catch {
        /* ignore */
      }
    },
    getJSON: <T>(name: string) => {
      const raw = safeGet(store, key(name));
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    setJSON: (name, value) => {
      try {
        return safeSet(store, key(name), JSON.stringify(value));
      } catch {
        return false;
      }
    },
  };
}

function safeGet(store: StorageLike, k: string): string | null {
  try {
    return store.getItem(k);
  } catch {
    return null;
  }
}

function safeSet(store: StorageLike, k: string, v: string): boolean {
  try {
    store.setItem(k, v);
    return true;
  } catch {
    return false;
  }
}
