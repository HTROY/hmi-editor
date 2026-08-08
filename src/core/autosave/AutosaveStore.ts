import type { AutosaveSnapshot } from "./types";

// ============================================================
// AutosaveStore — 自动保存的持久化适配器
// 浏览器使用 IndexedDB；core 测试使用内存实现，无需 DOM
// ============================================================

export interface AutosaveStore {
  save(snapshot: AutosaveSnapshot): Promise<void>;
  load(): Promise<AutosaveSnapshot | null>;
  clear(): Promise<void>;
}

const DB_NAME = "hmi-editor-autosave";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";
const RECORD_ID = "current";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

/** 浏览器 IndexedDB 适配器 */
export function createIndexedDbAutosaveStore(): AutosaveStore {
  return {
    async save(snapshot) {
      const db = await openDatabase();
      try {
        await requestToPromise(
          db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put({
            id: RECORD_ID,
            snapshot,
            updatedAt: new Date().toISOString(),
          })
        );
      } finally {
        db.close();
      }
    },

    async load() {
      const db = await openDatabase();
      try {
        const record = await requestToPromise(
          db
            .transaction(STORE_NAME, "readonly")
            .objectStore(STORE_NAME)
            .get(RECORD_ID)
        );
        return (record?.snapshot as AutosaveSnapshot | undefined) ?? null;
      } finally {
        db.close();
      }
    },

    async clear() {
      const db = await openDatabase();
      try {
        await requestToPromise(
          db
            .transaction(STORE_NAME, "readwrite")
            .objectStore(STORE_NAME)
            .delete(RECORD_ID)
        );
      } finally {
        db.close();
      }
    },
  };
}

/** 内存适配器（测试用） */
export function createMemoryAutosaveStore(): AutosaveStore {
  let current: AutosaveSnapshot | null = null;
  return {
    async save(snapshot) {
      current = structuredClone(snapshot);
    },
    async load() {
      return current ? structuredClone(current) : null;
    },
    async clear() {
      current = null;
    },
  };
}
