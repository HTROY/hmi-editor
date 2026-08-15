import { describe, expect, it } from "vitest";
import { ProjectManager } from "./ProjectManager";
import type { ClockPort, DownloadPort, StoragePort } from "../platform/ports";

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

describe("ProjectManager 平台端口注入（F08）", () => {
  function memoryStorage(
    initial: Record<string, string> = {}
  ): StoragePort & { data: Record<string, string> } {
    const data = { ...initial };
    return {
      data,
      getItem: (key) => (key in data ? data[key] : null),
      setItem: (key, value) => {
        data[key] = value;
      },
      removeItem: (key) => {
        delete data[key];
      },
    };
  }

  it("注入的 storage 端口持久化最近文件与远端关联", () => {
    const storage = memoryStorage();
    const pm = new ProjectManager({ storage });
    pm.addRecentFile("E:/a.hmi");
    expect(pm.recentFiles[0].path).toBe("E:/a.hmi");
    pm.setRemoteLink({ id: "p1", name: "线路1", version: 3, linkedAt: "t" });

    // 新实例从同一存储恢复
    const restored = new ProjectManager({ storage });
    expect(restored.recentFiles[0].path).toBe("E:/a.hmi");
    expect(restored.remoteLink?.id).toBe("p1");

    pm.setRemoteLink(null);
    const cleared = new ProjectManager({ storage });
    expect(cleared.remoteLink).toBeNull();
  });

  it("下载端口接收正确的文件名与内容类型", async () => {
    const downloads: Array<{ filename: string; mimeType: string }> = [];
    const download: DownloadPort = {
      download: (filename, _content, mimeType) =>
        downloads.push({ filename, mimeType }),
    };
    const pm = new ProjectManager({ download, storage: memoryStorage() });
    pm.meta.name = "测试工程";
    pm.downloadProject();
    expect(downloads[0]).toMatchObject({
      filename: "测试工程.hmi.json",
      mimeType: "application/json",
    });

    await pm.downloadProjectPackage();
    expect(downloads[1]).toMatchObject({
      filename: "测试工程.hmi.zip",
      mimeType: "application/zip",
    });
  });

  it("时钟端口控制页面与工程的时间戳", () => {
    const t = 1_700_000_000_000;
    const clock: ClockPort = {
      now: () => t,
      isoNow: () => new Date(t).toISOString(),
    };
    const pm = new ProjectManager({ clock, storage: memoryStorage() });
    const { meta } = pm.createPage("页");
    expect(meta.createdAt).toBe(new Date(t).toISOString());
    pm.renamePage(meta.id, "页2");
    expect(pm.getPageMeta(meta.id)?.updatedAt).toBe(new Date(t).toISOString());
  });
});
