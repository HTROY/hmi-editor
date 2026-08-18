import { ProjectManager } from "./ProjectManager";
import type { LibraryItem } from "../shapes/library";
import { createLibraryItem } from "../shapes/library";
import type { ShapeBase } from "../shapes";
import {
  addGroup,
  deleteGroup,
  emptyGrouping,
  isBuiltinSectionKey,
  mergeCollapsed,
  moveGroup,
  moveItemToGroup,
  renameGroup,
  toggleCollapsed,
  type LibraryGroup,
  type LibraryGrouping,
} from "../shapes/libraryGroups";

// 图元库折叠状态：内置分类只存 localStorage；
// 自定义分组与未分组双写工程文件 + localStorage，工程文件优先
const LIBRARY_COLLAPSED_STORAGE_KEY = "hmi-editor:shape-library:collapsed";

const NOOP_STORAGE: Pick<Storage, "getItem" | "setItem"> = {
  getItem: () => null,
  setItem: () => {},
};

export interface LibraryCommitState {
  library: LibraryItem[];
  libraryGroups: LibraryGroup[];
  libraryCollapsed: string[];
}

export interface LibraryControllerOptions {
  projectManager: ProjectManager;
  /** localStorage 实现（测试注入内存存储；缺省回退浏览器 localStorage） */
  storage?: Pick<Storage, "getItem" | "setItem">;
  /**
   * 镜像提交：store 据此同步 library/libraryGroups/libraryCollapsed；
   * persist=false 表示纯 UI 态（内置分类折叠），不应递增 libraryRevision。
   */
  onLibraryChanged?: (state: LibraryCommitState, persist: boolean) => void;
  /** 持久化收尾（store：flushAutosave）；仅 persist=true 时触发 */
  onPersist?: () => void;
}

/**
 * LibraryController — 图元库变更统一入口
 *
 * 库项/分组/折叠的每次变更收敛为一条路径：
 *   纯函数计算 → 工程写入（ProjectManager）→ localStorage（折叠）→
 *   镜像通知（onLibraryChanged）→ 持久化收尾（onPersist）
 *
 * store 动作退化为薄委托，消除逐动作重复的
 * 「set({library,...}) + setLibrary + flushAutosave」仪式；
 * 工程文件（PM）与 store 镜像不会再漂移。
 */
export class LibraryController {
  private readonly pm: ProjectManager;
  private readonly storage: Pick<Storage, "getItem" | "setItem">;
  private readonly onLibraryChanged?: (
    state: LibraryCommitState,
    persist: boolean
  ) => void;
  private readonly onPersist?: () => void;

  constructor(opts: LibraryControllerOptions) {
    this.pm = opts.projectManager;
    this.storage =
      opts.storage ??
      (typeof localStorage !== "undefined" ? localStorage : NOOP_STORAGE);
    this.onLibraryChanged = opts.onLibraryChanged;
    this.onPersist = opts.onPersist;
  }

  // ---- 折叠状态存储（内置分类只进 localStorage） ----

  /** 读取 localStorage 折叠状态（含内置分类键） */
  loadCollapsed(): string[] {
    try {
      const raw = this.storage.getItem(LIBRARY_COLLAPSED_STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((k): k is string => typeof k === "string")
        : [];
    } catch {
      return [];
    }
  }

  /** 写入 localStorage 折叠状态（工程优先键由 PM 负责） */
  saveCollapsed(keys: string[]): void {
    try {
      this.storage.setItem(
        LIBRARY_COLLAPSED_STORAGE_KEY,
        JSON.stringify([...new Set(keys)])
      );
    } catch {
      /* ignore */
    }
  }

  // ---- 库项 ----

  /** 新增库项（保存选中图元 / SVG 导入入库） */
  addItem(
    shapes: ShapeBase[],
    name: string,
    groupId?: string
  ): LibraryItem | null {
    if (shapes.length === 0) return null;
    const item = createLibraryItem(shapes, name, groupId);
    const items = [...this.pm.getLibrary(), item];
    this.commit({ items }, true);
    return item;
  }

  /** 重命名库项：空名回退原名；始终刷新 updatedAt */
  renameItem(id: string, name: string): void {
    const current = this.pm.getLibrary();
    if (!current.some((item) => item.id === id)) return;
    const items = current.map((item) =>
      item.id === id
        ? {
            ...item,
            name: name.trim() || item.name,
            updatedAt: new Date().toISOString(),
          }
        : item
    );
    this.commit({ items }, true);
  }

  /** 删除库项 */
  deleteItem(id: string): void {
    const items = this.pm.getLibrary().filter((item) => item.id !== id);
    if (items.length === this.pm.getLibrary().length) return;
    this.commit({ items }, true);
  }

  /** 覆盖更新库项：保留 id/createdAt/groupId，内容替换为画布选中图元 */
  overwriteItem(id: string, shapes: ShapeBase[]): void {
    const target = this.pm.getLibrary().find((item) => item.id === id);
    if (!target || shapes.length === 0) return;
    const rebuilt = createLibraryItem(shapes, target.name);
    const items = this.pm.getLibrary().map((item) =>
      item.id === id
        ? {
            ...rebuilt,
            id: item.id,
            createdAt: item.createdAt,
            updatedAt: new Date().toISOString(),
            groupId: item.groupId,
          }
        : item
    );
    this.commit({ items }, true);
  }

  // ---- 分组与折叠 ----

  /** 新建分组；失败返回 false（空名/重名） */
  addGroup(name: string): boolean {
    const grouping = this.currentGrouping();
    const result = addGroup(grouping, name);
    if (!result.ok) return false;
    return this.commitFrom(grouping, result.state, true);
  }

  /** 重命名分组；失败返回 false */
  renameGroup(id: string, name: string): boolean {
    const grouping = this.currentGrouping();
    const result = renameGroup(grouping, id, name);
    if (!result.ok) return false;
    return this.commitFrom(grouping, result.state, true);
  }

  /** 删除分组：组内库项回到未分组，折叠记录一并清除 */
  deleteGroup(id: string): void {
    const grouping = this.currentGrouping();
    const state = deleteGroup(grouping, id);
    this.commitFrom(grouping, state, true);
  }

  /** 移动库项归属（groupId 为 null 回到未分组） */
  moveItemToGroup(itemId: string, groupId: string | null): void {
    const grouping = this.currentGrouping();
    const state = moveItemToGroup(grouping, itemId, groupId);
    this.commitFrom(grouping, state, true);
  }

  /** 拖拽排序分组 */
  moveGroup(id: string, targetIndex: number): void {
    const grouping = this.currentGrouping();
    const state = moveGroup(grouping, id, targetIndex);
    this.commitFrom(grouping, state, true);
  }

  /**
   * 切换折叠状态：内置分类只写 localStorage（persist=false，不触发自动保存）；
   * 自定义分组/未分组双写工程 + localStorage（persist=true）。
   */
  toggleCollapsed(key: string): void {
    const grouping = this.currentGrouping();
    const state = toggleCollapsed(grouping, key);
    if (state.collapsed === grouping.collapsed) return;
    this.commit({ collapsed: state.collapsed }, !isBuiltinSectionKey(key));
  }

  // ---- 内部 ----

  /** 从工程 + localStorage 重建当前分组状态（镜像与 PM 保持同步的前提） */
  private currentGrouping(): LibraryGrouping {
    const pm = this.pm;
    const merged = mergeCollapsed(
      pm.getLibraryUi().collapsed,
      this.loadCollapsed(),
      pm.getLibraryGroups().map((g) => g.id)
    );
    return emptyGrouping(pm.getLibrary(), pm.getLibraryGroups(), merged);
  }

  /** 对比纯函数前后引用：无变化则不提交（避免虚假 revision/持久化） */
  private commitFrom(
    grouping: LibraryGrouping,
    next: LibraryGrouping,
    persist: boolean
  ): boolean {
    if (
      next.items === grouping.items &&
      next.groups === grouping.groups &&
      next.collapsed === grouping.collapsed
    ) {
      return false;
    }
    this.commit(
      {
        items: next.items !== grouping.items ? next.items : undefined,
        groups: next.groups !== grouping.groups ? next.groups : undefined,
        collapsed:
          next.collapsed !== grouping.collapsed ? next.collapsed : undefined,
      },
      persist
    );
    return true;
  }

  /** 统一提交：工程写入 → 折叠持久化 → 镜像通知 → 持久化收尾 */
  private commit(
    opts: {
      items?: LibraryItem[];
      groups?: LibraryGroup[];
      collapsed?: string[];
    },
    persist: boolean
  ): void {
    const pm = this.pm;
    if (opts.items !== undefined) pm.setLibrary(opts.items);
    if (opts.groups !== undefined) pm.setLibraryGroups(opts.groups);
    if (opts.collapsed !== undefined) {
      if (persist) {
        pm.setLibraryUi({
          collapsed: opts.collapsed.filter((k) => !isBuiltinSectionKey(k)),
        });
      }
      this.saveCollapsed(opts.collapsed);
    }
    this.onLibraryChanged?.(
      {
        library: opts.items ?? pm.getLibrary(),
        libraryGroups: opts.groups ?? pm.getLibraryGroups(),
        libraryCollapsed:
          opts.collapsed ??
          mergeCollapsed(
            pm.getLibraryUi().collapsed,
            this.loadCollapsed(),
            pm.getLibraryGroups().map((g) => g.id)
          ),
      },
      persist
    );
    if (persist) this.onPersist?.();
  }
}
