import { describe, expect, it } from "vitest";
import { createMemoryDraftBackupStore, type DraftBackup } from "./backup";

// ============================================================
// backup.test.ts — 本地草稿备份存储
// ============================================================

function makeBackup(id: string, name: string, savedAt: string): DraftBackup {
  return {
    id,
    name,
    savedAt,
    project: {
      schemaVersion: 1,
      meta: {
        name,
        version: "0.1.0",
        description: "",
        author: "",
        stationName: "",
        lineName: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: savedAt,
      },
      pages: [],
    },
    activePageId: "page_1",
    views: { page_1: { zoom: 1, panX: 0, panY: 0 } },
  };
}

describe("DraftBackupStore (memory)", () => {
  it("saves, lists newest first, loads and removes backups", async () => {
    const store = createMemoryDraftBackupStore();
    await store.save(makeBackup("b1", "草稿A", "2026-08-08T10:00:00Z"));
    await store.save(makeBackup("b2", "草稿B", "2026-08-09T10:00:00Z"));

    const list = await store.list();
    expect(list.map((b) => b.id)).toEqual(["b2", "b1"]);

    const loaded = await store.load("b1");
    expect(loaded?.name).toBe("草稿A");

    await store.remove("b2");
    expect((await store.list()).map((b) => b.id)).toEqual(["b1"]);
    expect(await store.load("b2")).toBeNull();
  });

  it("loads missing backups as null", async () => {
    const store = createMemoryDraftBackupStore();
    expect(await store.load("missing")).toBeNull();
  });
});
