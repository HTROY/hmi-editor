import { describe, expect, it } from "vitest";
import { ProjectManager } from "./ProjectManager";

describe("ProjectManager.setPageBackground", () => {
  it("updates the page background and marks the project dirty", () => {
    const pm = new ProjectManager();
    pm.newProject();
    const pageId = pm.activePageId;

    pm.setPageBackground(pageId, "#0c1520");

    expect(pm.getPageMeta(pageId)?.background).toBe("#0c1520");
    expect(pm.dirty).toBe(true);
  });

  it("keeps the existing background when the page does not exist", () => {
    const pm = new ProjectManager();
    pm.newProject();
    const before = pm.getPageMeta(pm.activePageId)?.background;

    pm.setPageBackground("missing_page", "#000000");

    expect(pm.getPageMeta(pm.activePageId)?.background).toBe(before);
    expect(pm.dirty).toBe(false);
  });
});

describe("ProjectManager 图元库分组", () => {
  it("分组与折叠状态随工程导出/导入往返", () => {
    const pm = new ProjectManager();
    pm.newProject();
    pm.setLibraryGroups([
      { id: "grp_1", name: "供电" },
      { id: "grp_2", name: "BAS" },
    ]);
    pm.setLibraryUi({ collapsed: ["grp_1", "@ungrouped"] });
    pm.setLibrary([
      {
        id: "lib_1",
        name: "断路器",
        groupId: "grp_1",
        shape: { id: "s1", type: "rect" } as any,
        createdAt: "",
        updatedAt: "",
      },
    ]);

    const restored = new ProjectManager();
    restored.importProject(pm.exportProject());

    expect(restored.getLibraryGroups()).toEqual([
      { id: "grp_1", name: "供电" },
      { id: "grp_2", name: "BAS" },
    ]);
    expect(restored.getLibraryUi()).toEqual({
      collapsed: ["grp_1", "@ungrouped"],
    });
    expect(restored.getLibrary()[0].groupId).toBe("grp_1");
  });

  it("新建工程清空分组与折叠状态", () => {
    const pm = new ProjectManager();
    pm.newProject();
    pm.setLibraryGroups([{ id: "grp_1", name: "供电" }]);
    pm.setLibraryUi({ collapsed: ["grp_1"] });

    pm.newProject();

    expect(pm.getLibraryGroups()).toEqual([]);
    expect(pm.getLibraryUi()).toEqual({ collapsed: [] });
  });
});
