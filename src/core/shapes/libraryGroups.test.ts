import { describe, expect, it } from "vitest";
import {
  addGroup,
  deleteGroup,
  emptyGrouping,
  moveGroup,
  moveItemToGroup,
  normalizeGrouping,
  renameGroup,
  toggleCollapsed,
  UNGROUPED_KEY,
} from "./libraryGroups";

describe("addGroup 新建分组", () => {
  it("命名分组追加到末尾并生成稳定 id", () => {
    const state = emptyGrouping([]);
    const result = addGroup(state, "供电二所");

    expect(result.ok).toBe(true);
    expect(result.state.groups).toHaveLength(1);
    const group = result.state.groups[0];
    expect(group.name).toBe("供电二所");
    expect(group.id).toMatch(/^grp_/);
  });

  it("空名称与重复名称返回错误且不修改状态", () => {
    const state = emptyGrouping([]);
    const added = addGroup(state, "BAS");

    expect(addGroup(state, "  ").ok).toBe(false);
    expect(addGroup(added.state, "BAS").ok).toBe(false);
    expect(added.state.groups).toHaveLength(1);
  });

  it("新分组默认不在折叠集合中", () => {
    const state = emptyGrouping([], [], ["@ungrouped"]);
    const result = addGroup(state, "通用");

    expect(result.ok).toBe(true);
    expect(result.state.collapsed).toEqual(["@ungrouped"]);
  });
});

describe("renameGroup 重命名分组", () => {
  it("重命名后保留 id 与顺序", () => {
    const base = emptyGrouping([]);
    const added = addGroup(base, "BAS");
    const group = added.state.groups[0];
    const result = renameGroup(added.state, group.id, "环控系统");

    expect(result.ok).toBe(true);
    expect(result.state.groups).toEqual([{ id: group.id, name: "环控系统" }]);
  });

  it("重名、空名称或未知 id 返回错误且不修改", () => {
    const base = emptyGrouping([]);
    const a = addGroup(base, "供电").state;
    const b = addGroup(a, "BAS").state;
    const bas = b.groups[1];

    expect(renameGroup(b, bas.id, "供电").ok).toBe(false);
    expect(renameGroup(b, bas.id, "  ").ok).toBe(false);
    expect(renameGroup(b, "grp_missing", "新名").ok).toBe(false);
    expect(b.groups.map((g) => g.name)).toEqual(["供电", "BAS"]);
  });
});

describe("deleteGroup 删除分组", () => {
  it("删除分组并清空组内库项归属与折叠记录", () => {
    const base = emptyGrouping([]);
    const added = addGroup(base, "供电").state;
    const group = added.groups[0];
    const item = {
      id: "lib_1",
      name: "断路器",
      shape: { id: "s1", type: "rect" } as any,
      createdAt: "",
      updatedAt: "",
      groupId: group.id,
    };
    const withItem = emptyGrouping([item], added.groups, [
      group.id,
      "@ungrouped",
    ]);

    const result = deleteGroup(withItem, group.id);

    expect(result.groups).toEqual([]);
    expect(result.items[0].groupId).toBeUndefined();
    expect(result.collapsed).toEqual(["@ungrouped"]);
  });

  it("未知分组 id 不修改状态", () => {
    const state = emptyGrouping([]);
    expect(deleteGroup(state, "grp_missing")).toBe(state);
  });
});

describe("moveItemToGroup 移动库项归属", () => {
  const item = {
    id: "lib_1",
    name: "断路器",
    shape: { id: "s1", type: "rect" } as any,
    createdAt: "",
    updatedAt: "",
  };

  it("指定到分组或清空回未分组", () => {
    const base = emptyGrouping([item]);
    const added = addGroup(base, "供电").state;
    const group = added.groups[0];

    const assigned = moveItemToGroup(added, item.id, group.id);
    expect(assigned.items[0].groupId).toBe(group.id);

    const ungrouped = moveItemToGroup(assigned, item.id, null);
    expect(ungrouped.items[0].groupId).toBeUndefined();
  });

  it("未知分组或未知库项不修改状态", () => {
    const base = emptyGrouping([item]);
    const added = addGroup(base, "供电").state;

    expect(moveItemToGroup(added, item.id, "grp_missing")).toBe(added);
    expect(moveItemToGroup(added, "lib_missing", added.groups[0].id)).toBe(
      added
    );
  });
});

describe("moveGroup 拖拽排序", () => {
  it("按 id 移动到目标索引并保持其余顺序", () => {
    const base = emptyGrouping([]);
    const a = addGroup(base, "A").state;
    const b = addGroup(a, "B").state;
    const c = addGroup(b, "C").state;

    const moved = moveGroup(c, c.groups[2].id, 0);
    expect(moved.groups.map((g) => g.name)).toEqual(["C", "A", "B"]);
  });

  it("目标索引越界时收敛到边界", () => {
    const base = emptyGrouping([]);
    const a = addGroup(base, "A").state;
    const b = addGroup(a, "B").state;

    const moved = moveGroup(b, b.groups[0].id, 99);
    expect(moved.groups.map((g) => g.name)).toEqual(["B", "A"]);
  });

  it("未知分组 id 不修改状态", () => {
    const state = emptyGrouping([]);
    expect(moveGroup(state, "grp_missing", 0)).toBe(state);
  });
});

describe("toggleCollapsed 折叠状态", () => {
  it("不存在则加入，存在则移除，其余保持", () => {
    const state = emptyGrouping([], [], ["builtin:基本"]);
    const added = toggleCollapsed(state, "grp_1");
    expect(added.collapsed).toEqual(["builtin:基本", "grp_1"]);

    const removed = toggleCollapsed(added, "grp_1");
    expect(removed.collapsed).toEqual(["builtin:基本"]);
  });
});

describe("normalizeGrouping 工程数据归一化", () => {
  it("分组 id/名称重复时追加后缀，无效条目丢弃", () => {
    const result = normalizeGrouping(
      [],
      [
        { id: "grp_1", name: "供电" },
        { id: "grp_1", name: "BAS" },
        { id: "grp_2", name: "供电" },
        { id: "grp_bad", name: "  " },
        { id: "", name: "无名" },
      ]
    );

    expect(result.groups).toEqual([
      { id: "grp_1", name: "供电" },
      { id: "grp_1_2", name: "BAS" },
      { id: "grp_2", name: "供电_2" },
    ]);
  });

  it("无效 groupId 清除，折叠集合只保留有效分组与未分组", () => {
    const item = {
      id: "lib_1",
      name: "断路器",
      shape: { id: "s1", type: "rect" } as any,
      createdAt: "",
      updatedAt: "",
      groupId: "grp_missing",
    };
    const result = normalizeGrouping(
      [item],
      [{ id: "grp_1", name: "供电" }],
      ["grp_1", "grp_missing", "builtin:基本", UNGROUPED_KEY, UNGROUPED_KEY]
    );

    expect(result.items[0].groupId).toBeUndefined();
    expect(result.collapsed).toEqual(["grp_1", UNGROUPED_KEY]);
  });
});
