import type { LibraryItem } from "./library";

// ============================================================
// libraryGroups.ts — 图元库自定义分组与折叠状态核心逻辑
// 分组/折叠状态属于工程数据（见规范 #22）；
// 本模块保持纯函数、不可变更新，UI 与 store 只做薄调用
// ============================================================

export interface LibraryGroup {
  id: string;
  name: string;
}

/** 工程文件中的自定义分组 UI 状态 */
export interface LibraryUi {
  collapsed: string[];
}

/** 图元库分组相关状态（库项、分组、折叠集合） */
export interface LibraryGrouping {
  items: LibraryItem[];
  groups: LibraryGroup[];
  collapsed: string[];
}

/** 「未分组」在折叠集合中的固定 key（不属于任何分组实体） */
export const UNGROUPED_KEY = "@ungrouped";

/** 内置分类折叠 key 前缀（仅用于 localStorage） */
export const BUILTIN_KEY_PREFIX = "builtin:";

export function isBuiltinSectionKey(key: string): boolean {
  return key.startsWith(BUILTIN_KEY_PREFIX);
}

export function generateLibraryGroupId(): string {
  return (
    "grp_" +
    Date.now().toString(36) +
    "_" +
    Math.floor(Math.random() * 0xffff).toString(36)
  );
}

/** 构造分组状态；collapsed 按传入顺序去重保留 */
export function emptyGrouping(
  items: LibraryItem[],
  groups: LibraryGroup[] = [],
  collapsed: string[] = []
): LibraryGrouping {
  return { items, groups, collapsed: [...new Set(collapsed)] };
}

export interface GroupingResult {
  ok: boolean;
  error?: string;
  state: LibraryGrouping;
}

/** 新建分组：追加到末尾；空名称/重名返回错误 */
export function addGroup(state: LibraryGrouping, name: string): GroupingResult {
  const trimmed = name.trim();
  if (!trimmed) {
    return { ok: false, error: "请输入分组名", state };
  }
  if (state.groups.some((g) => g.name === trimmed)) {
    return { ok: false, error: "分组名已存在", state };
  }
  const group: LibraryGroup = {
    id: generateLibraryGroupId(),
    name: trimmed,
  };
  return {
    ok: true,
    state: { ...state, groups: [...state.groups, group] },
  };
}

/** 重命名分组：保留 id 与顺序；空名称/重名/未知 id 返回错误 */
export function renameGroup(
  state: LibraryGrouping,
  id: string,
  name: string
): GroupingResult {
  const trimmed = name.trim();
  const target = state.groups.find((g) => g.id === id);
  if (!target) {
    return { ok: false, error: "分组不存在", state };
  }
  if (!trimmed) {
    return { ok: false, error: "请输入分组名", state };
  }
  if (state.groups.some((g) => g.id !== id && g.name === trimmed)) {
    return { ok: false, error: "分组名已存在", state };
  }
  return {
    ok: true,
    state: {
      ...state,
      groups: state.groups.map((g) =>
        g.id === id ? { ...g, name: trimmed } : g
      ),
    },
  };
}

/** 删除分组：组内库项回到未分组，折叠记录一并清除 */
export function deleteGroup(
  state: LibraryGrouping,
  id: string
): LibraryGrouping {
  if (!state.groups.some((g) => g.id === id)) return state;
  return {
    ...state,
    groups: state.groups.filter((g) => g.id !== id),
    items: state.items.map((item) =>
      item.groupId === id ? { ...item, groupId: undefined } : item
    ),
    collapsed: state.collapsed.filter((key) => key !== id),
  };
}

/** 移动库项归属：groupId 为 null/undefined 时回到未分组 */
export function moveItemToGroup(
  state: LibraryGrouping,
  itemId: string,
  groupId: string | null | undefined
): LibraryGrouping {
  const item = state.items.find((i) => i.id === itemId);
  if (!item) return state;
  if (groupId !== null && groupId !== undefined) {
    if (!state.groups.some((g) => g.id === groupId)) return state;
  }
  return {
    ...state,
    items: state.items.map((i) =>
      i.id === itemId ? { ...i, groupId: groupId ?? undefined } : i
    ),
  };
}

/** 拖拽排序：把分组移到目标索引，索引越界时收敛到边界 */
export function moveGroup(
  state: LibraryGrouping,
  id: string,
  targetIndex: number
): LibraryGrouping {
  const from = state.groups.findIndex((g) => g.id === id);
  if (from < 0) return state;
  const groups = [...state.groups];
  const [group] = groups.splice(from, 1);
  const clamped = Math.max(0, Math.min(targetIndex, groups.length));
  groups.splice(clamped, 0, group);
  return { ...state, groups };
}

/** 切换折叠状态：不存在则加入，存在则移除 */
export function toggleCollapsed(
  state: LibraryGrouping,
  key: string
): LibraryGrouping {
  const collapsed = state.collapsed.includes(key)
    ? state.collapsed.filter((k) => k !== key)
    : [...state.collapsed, key];
  return { ...state, collapsed };
}

/** 工程数据归一化：分组 id/名称去重、丢弃无效条目、清理失效归属与折叠记录 */
export function normalizeGrouping(
  items: LibraryItem[],
  groups: LibraryGroup[] = [],
  collapsed: string[] = []
): LibraryGrouping {
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const normalizedGroups: LibraryGroup[] = [];

  for (const raw of groups) {
    if (!raw || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!id || !name) continue;

    let uniqueId = id;
    if (seenIds.has(uniqueId)) {
      let suffix = 2;
      while (seenIds.has(`${uniqueId}_${suffix}`)) suffix++;
      uniqueId = `${uniqueId}_${suffix}`;
    }
    seenIds.add(uniqueId);

    let uniqueName = name;
    if (seenNames.has(uniqueName)) {
      let suffix = 2;
      while (seenNames.has(`${uniqueName}_${suffix}`)) suffix++;
      uniqueName = `${uniqueName}_${suffix}`;
    }
    seenNames.add(uniqueName);
    normalizedGroups.push({ id: uniqueId, name: uniqueName });
  }

  const validIds = new Set(normalizedGroups.map((g) => g.id));
  const normalizedItems = items.map((item) =>
    item.groupId && !validIds.has(item.groupId)
      ? { ...item, groupId: undefined }
      : item
  );
  const normalizedCollapsed = [
    ...new Set(
      collapsed.filter(
        (key) =>
          typeof key === "string" &&
          (key === UNGROUPED_KEY || validIds.has(key))
      )
    ),
  ];

  return {
    items: normalizedItems,
    groups: normalizedGroups,
    collapsed: normalizedCollapsed,
  };
}
