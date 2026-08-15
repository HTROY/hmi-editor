import { describe, expect, it, beforeEach } from "vitest";
import { LibraryController } from "./LibraryController";
import type { LibraryCommitState } from "./LibraryController";
import { ProjectManager } from "./ProjectManager";
import { createShape } from "../shapes";

/** 内存版 localStorage（折叠状态注入用） */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function makeHarness() {
  const pm = new ProjectManager();
  const storage = new MemoryStorage();
  let lastChanged: LibraryCommitState | null = null;
  const changed: { persist: boolean }[] = [];
  let persists = 0;
  const controller = new LibraryController({
    projectManager: pm,
    storage,
    onLibraryChanged: (state, persist) => {
      lastChanged = state;
      changed.push({ persist });
    },
    onPersist: () => {
      persists++;
    },
  });
  return {
    pm,
    storage,
    controller,
    getLast: () => lastChanged,
    changed,
    getPersists: () => persists,
  };
}

const rect = (id: string) => createShape("rect", { id, x: 0, y: 0 });

describe("LibraryController 库项", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it("addItem 写入工程并通知镜像（persist=true）", () => {
    const item = h.controller.addItem([rect("s1")], "断路器");
    expect(item).not.toBeNull();
    expect(h.pm.getLibrary().map((i) => i.name)).toEqual(["断路器"]);
    expect(h.getLast()!.library.map((i) => i.id)).toEqual([item!.id]);
    expect(h.changed[h.changed.length - 1]!.persist).toBe(true);
    expect(h.getPersists()).toBe(1);
  });

  it("addItem 空图元返回 null 且不提交", () => {
    expect(h.controller.addItem([], "空")).toBeNull();
    expect(h.changed.length).toBe(0);
  });

  it("renameItem 重命名并刷新 updatedAt；空名回退原名", () => {
    const item = h.controller.addItem([rect("s1")], "旧名")!;
    const before = item.updatedAt;
    h.controller.renameItem(item.id, "新名");
    expect(h.pm.getLibrary()[0].name).toBe("新名");
    h.controller.renameItem(item.id, "   ");
    expect(h.pm.getLibrary()[0].name).toBe("新名");
    expect(h.pm.getLibrary()[0].updatedAt >= before).toBe(true);
  });

  it("renameItem 未知 id 不提交", () => {
    const before = h.changed.length;
    h.controller.renameItem("missing", "x");
    expect(h.changed.length).toBe(before);
  });

  it("deleteItem 删除库项；未知 id 不提交", () => {
    const item = h.controller.addItem([rect("s1")], "待删")!;
    h.controller.deleteItem(item.id);
    expect(h.pm.getLibrary()).toEqual([]);
    const before = h.changed.length;
    h.controller.deleteItem("missing");
    expect(h.changed.length).toBe(before);
  });

  it("overwriteItem 替换内容但保留 id/createdAt/groupId", () => {
    h.controller.addGroup("供电");
    const group = h.pm.getLibraryGroups()[0];
    const item = h.controller.addItem([rect("s1")], "断路器", group.id)!;
    const before = { id: item.id, createdAt: item.createdAt, groupId: group.id };
    h.controller.overwriteItem(item.id, [
      createShape("rect", { id: "s2", x: 42, y: 0 }),
    ]);
    const after = h.pm.getLibrary()[0];
    expect(after.id).toBe(before.id);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.groupId).toBe(before.groupId);
    expect(after.shape.id).toBe("s2"); // 内容已替换为新图元
    expect(after.shape.x).toBe(42);
    expect(after.updatedAt >= before.createdAt).toBe(true);
  });
});

describe("LibraryController 分组与折叠", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it("addGroup 成功返回 true 并写入工程；重名返回 false", () => {
    expect(h.controller.addGroup("供电")).toBe(true);
    expect(h.pm.getLibraryGroups().map((g) => g.name)).toEqual(["供电"]);
    expect(h.controller.addGroup("供电")).toBe(false);
    expect(h.pm.getLibraryGroups().length).toBe(1);
  });

  it("renameGroup 重命名并返回布尔；未知 id 失败", () => {
    h.controller.addGroup("供电");
    expect(h.controller.renameGroup(h.pm.getLibraryGroups()[0].id, "BAS")).toBe(true);
    expect(h.pm.getLibraryGroups()[0].name).toBe("BAS");
    expect(h.controller.renameGroup("missing", "x")).toBe(false);
  });

  it("deleteGroup 组内库项回到未分组并清除折叠记录", () => {
    h.controller.addGroup("供电");
    const group = h.pm.getLibraryGroups()[0];
    h.controller.toggleCollapsed(group.id); // 折叠该组（工程键）
    const item = h.controller.addItem([rect("s1")], "断路器")!;
    h.controller.moveItemToGroup(item.id, group.id);
    h.controller.deleteGroup(group.id);
    expect(h.pm.getLibraryGroups()).toEqual([]);
    expect(h.pm.getLibrary()[0].groupId).toBeUndefined();
    expect(h.pm.getLibraryUi().collapsed).not.toContain(group.id);
  });

  it("moveGroup 拖拽排序", () => {
    h.controller.addGroup("A");
    h.controller.addGroup("B");
    h.controller.addGroup("C");
    const groups = h.pm.getLibraryGroups();
    h.controller.moveGroup(groups[2].id, 0);
    const ids = h.pm.getLibraryGroups().map((g) => g.id);
    expect(ids[0]).toBe(groups[2].id);
    expect(ids[1]).toBe(groups[0].id);
    expect(ids[2]).toBe(groups[1].id);
  });

  it("moveItemToGroup 无变化时不提交", () => {
    const item = h.controller.addItem([rect("s1")], "未分组项")!;
    const before = h.changed.length;
    h.controller.moveItemToGroup(item.id, null); // 已在未分组
    expect(h.changed.length).toBe(before);
    expect(h.getPersists()).toBe(1);
  });

  it("toggleCollapsed 工程键：双写工程 + localStorage，触发持久化", () => {
    h.controller.addGroup("供电");
    const group = h.pm.getLibraryGroups()[0];
    h.controller.toggleCollapsed(group.id);
    expect(h.pm.getLibraryUi().collapsed).toEqual([group.id]);
    expect(h.getLast()!.libraryCollapsed).toContain(group.id);
    expect(h.changed[h.changed.length - 1]!.persist).toBe(true);
    expect(h.getPersists()).toBe(2); // addGroup + toggle
  });

  it("toggleCollapsed 内置键：只写 localStorage，不触发持久化且工程折叠不变", () => {
    h.controller.toggleCollapsed("builtin:basic");
    expect(h.pm.getLibraryUi().collapsed).toEqual([]);
    expect(h.getLast()!.libraryCollapsed).toContain("builtin:basic");
    expect(h.changed[h.changed.length - 1]!.persist).toBe(false);
    expect(h.getPersists()).toBe(0); // 未触发 flushAutosave
  });
});
