import type { ProjectData } from "./types";
import type { PageViewState } from "../autosave/types";

// ============================================================
// backup.ts — 本地草稿备份
// 打开远端工程前自动把当前本地草稿存成命名备份，可随时恢复
// ============================================================

export interface DraftBackup {
  id: string;
  name: string;
  savedAt: string;
  project: ProjectData;
  activePageId: string;
  views: Record<string, PageViewState>;
}

export interface DraftBackupStore {
  save(backup: DraftBackup): Promise<void>;
  list(): Promise<DraftBackup[]>;
  load(id: string): Promise<DraftBackup | null>;
  remove(id: string): Promise<void>;
}

const DB_NAME = "hmi-editor-backups";
const DB_VERSION = 1;
const STORE_NAME = "backups";
const MAX_BACKUPS = 20;

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

function isDraftBackup(value: unknown): value is DraftBackup {
  if (!value || typeof value !== "object") return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.id === "string" &&
    typeof b.name === "string" &&
    typeof b.savedAt === "string" &&
    !!b.project &&
    typeof b.project === "object" &&
    typeof b.activePageId === "string" &&
    !!b.views &&
    typeof b.views === "object"
  );
}

/** 浏览器 IndexedDB 草稿备份适配器 */
export function createIndexedDbDraftBackupStore(): DraftBackupStore {
  const store: DraftBackupStore = {
    async save(backup) {
      const db = await openDatabase();
      try {
        await requestToPromise(
          db
            .transaction(STORE_NAME, "readwrite")
            .objectStore(STORE_NAME)
            .put(backup)
        );
        // 只保留最近 MAX_BACKUPS 份
        const all = await store.list();
        const tx = db.transaction(STORE_NAME, "readwrite");
        const txStore = tx.objectStore(STORE_NAME);
        for (const stale of all.slice(MAX_BACKUPS)) {
          txStore.delete(stale.id);
        }
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("清理备份失败"));
        });
      } finally {
        db.close();
      }
    },

    async list() {
      const db = await openDatabase();
      try {
        const rows = await requestToPromise(
          db
            .transaction(STORE_NAME, "readonly")
            .objectStore(STORE_NAME)
            .getAll()
        );
        return (rows as unknown[])
          .filter(isDraftBackup)
          .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
      } finally {
        db.close();
      }
    },

    async load(id) {
      const db = await openDatabase();
      try {
        const row = await requestToPromise(
          db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id)
        );
        return isDraftBackup(row) ? row : null;
      } finally {
        db.close();
      }
    },

    async remove(id) {
      const db = await openDatabase();
      try {
        await requestToPromise(
          db
            .transaction(STORE_NAME, "readwrite")
            .objectStore(STORE_NAME)
            .delete(id)
        );
      } finally {
        db.close();
      }
    },
  };
  return store;
}

/** 内存适配器（测试/非浏览器环境用） */
export function createMemoryDraftBackupStore(): DraftBackupStore {
  const rows = new Map<string, DraftBackup>();
  return {
    async save(backup) {
      rows.set(backup.id, structuredClone(backup));
      for (const stale of [...rows.values()]
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
        .slice(MAX_BACKUPS)) {
        rows.delete(stale.id);
      }
    },
    async list() {
      return [...rows.values()]
        .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
        .map((b) => structuredClone(b));
    },
    async load(id) {
      const row = rows.get(id);
      return row ? structuredClone(row) : null;
    },
    async remove(id) {
      rows.delete(id);
    },
  };
}

export function createDraftBackup(
  name: string,
  project: ProjectData,
  activePageId: string,
  views: Record<string, PageViewState>
): DraftBackup {
  const stamp = new Date().toISOString();
  const suffix = Math.random().toString(36).slice(2, 7);
  return {
    id: `backup_${Date.now().toString(36)}_${suffix}`,
    name: name || "未命名工程",
    savedAt: stamp,
    project: structuredClone(project),
    activePageId,
    views: { ...views },
  };
}
