// 管理 UI 本地存储封装（F17）：带前缀、JSON 序列化、配额错误处理。
// 取代散落在 theme.tsx / operator.ts 中的裸 localStorage 访问。

export interface SafeStorage {
  get(key: string): string | null;
  /** 写入失败（配额/隐私模式）返回 false，不抛出 */
  set(key: string, value: string): boolean;
  remove(key: string): void;
  getJSON<T>(key: string): T | null;
  setJSON(key: string, value: unknown): boolean;
}

function defaultBacking(): Storage {
  return typeof localStorage !== "undefined" ? localStorage : nullStorage();
}

const nullStorage: () => Storage = () => {
  const noop = (): null => null;
  return {
    get length() {
      return 0;
    },
    clear: () => {},
    getItem: noop,
    key: () => null,
    removeItem: () => {},
    setItem: () => {},
  };
};

/** 创建带前缀的安全存储：`createStorage("hmi-io-").get("theme")` → 键 `hmi-io-theme` */
export function createStorage(
  prefix: string,
  backing: Storage = defaultBacking()
): SafeStorage {
  const key = (name: string): string => prefix + name;

  return {
    get: (name) => {
      try {
        return backing.getItem(key(name));
      } catch {
        return null;
      }
    },
    set: (name, value) => {
      try {
        backing.setItem(key(name), value);
        return true;
      } catch {
        return false;
      }
    },
    remove: (name) => {
      try {
        backing.removeItem(key(name));
      } catch {
        /* ignore */
      }
    },
    getJSON: <T>(name: string): T | null => {
      try {
        const raw = backing.getItem(key(name));
        if (raw === null) return null;
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    setJSON: (name, value) => {
      try {
        backing.setItem(key(name), JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
  };
}
