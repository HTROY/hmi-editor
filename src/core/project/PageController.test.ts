import { describe, expect, it } from "vitest";
import { SceneGraph, SceneEditor } from "../scene";
import { BindingEngine } from "../bindings";
import { VariableManager } from "../variables";
import { createShape } from "../shapes";
import { ProjectManager } from "./ProjectManager";
import { PageController } from "./PageController";
import type { PageViewState } from "../autosave";
import type { PageMeta, ProjectData } from "./types";

function make() {
  const scene = new SceneGraph();
  const varManager = new VariableManager();
  const bindingEngine = new BindingEngine(scene, varManager);
  const sceneEditor = new SceneEditor({ scene, bindingEngine });
  const projectManager = new ProjectManager();
  const events: string[] = [];
  const views: Record<string, PageViewState> = {};
  const controller = new PageController({
    scene,
    sceneEditor,
    bindingEngine,
    projectManager,
    callbacks: {
      onPageSwapped: (meta, opts) =>
        events.push(`swapped:${meta.id}:${opts.fullProject ? "full" : "page"}`),
      onViewportActivated: (pageId, vp) => {
        views[pageId] = { zoom: vp.zoom, panX: vp.panX, panY: vp.panY };
        events.push(`viewport:${pageId}`);
      },
      getPageView: (pageId) => views[pageId],
      onFlushAutosave: () => events.push("flush"),
    },
  });
  return {
    scene,
    bindingEngine,
    sceneEditor,
    projectManager,
    controller,
    events,
    views,
  };
}

const pageMeta = (
  id: string,
  title: string,
  width = 800,
  height = 600
): PageMeta => ({
  id,
  title,
  width,
  height,
  background: "#FFFFFF",
  order: 0,
  description: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const projectData = (): ProjectData => ({
  schemaVersion: 1,
  meta: {
    name: "新工程",
    version: "0.1.0",
    description: "",
    author: "",
    stationName: "",
    lineName: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  pages: [
    {
      meta: pageMeta("a", "A", 800, 600),
      shapes: [{ id: "s1", type: "rect", x: 10, y: 20 }],
    },
    {
      meta: pageMeta("b", "B", 1024, 768),
      shapes: [{ id: "s2", type: "circle", x: 0, y: 0 }],
    },
  ],
  library: [],
  libraryGroups: [],
  libraryUi: { collapsed: [] },
});

describe("PageController 页面加载路径", () => {
  it("loadProject：整体替换工程、加载活动页、重置历史并走完收尾", () => {
    const { scene, projectManager, controller, events } = make();
    controller.loadProject(projectData(), { fullProject: true, fit: true });

    expect(projectManager.activePageId).toBe("a");
    expect(projectManager.getPages()).toHaveLength(2);
    expect(scene.getAll().map((s) => s.id)).toEqual(["s1"]);
    expect(events).toEqual(["swapped:a:full", "viewport:a", "flush"]);
  });

  it("loadProject：无页面时抛出错误（与旧 loadProjectData 一致）", () => {
    const { controller } = make();
    const data = projectData();
    data.pages = [];
    expect(() => controller.loadProject(data)).toThrow("工程没有页面");
  });

  it("newProject：清空工程并加载默认主画面", () => {
    const { scene, projectManager, controller, events } = make();
    // 先造一个非空工程
    const p = projectManager.createPage("旧页").meta;
    projectManager.activePageId = p.id;
    scene.add(createShape("rect", { id: "old" }));

    controller.newProject({ fullProject: true, fit: true });

    const active = projectManager.activePage!;
    expect(active.meta.title).toBe("主画面");
    expect(scene.getAll()).toHaveLength(0);
    expect(projectManager.getLibrary()).toHaveLength(0);
    expect(events[0]).toBe(`swapped:${active.meta.id}:full`);
    expect(events).toContain("flush");
  });

  it("switchPage：先同步当前场景，切换后保留每页历史可切回", () => {
    const { scene, projectManager, controller, events } = make();
    const a = projectManager.createPage("A").meta;
    projectManager.activePageId = a.id;
    const b = projectManager.createPage("B").meta;
    scene.add(createShape("rect", { id: "ra" }));

    controller.switchPage(b.id);

    // 切换前当前场景已同步进工程
    expect(projectManager.getPageScene(a.id)?.get("ra")).toBeDefined();
    expect(projectManager.activePageId).toBe(b.id);
    expect(scene.getAll()).toHaveLength(0);
    expect(events[0]).toBe(`swapped:${b.id}:page`);

    // 切回：图元不丢失（历史保留，不重置）
    controller.switchPage(a.id);
    expect(scene.get("ra")).toBeDefined();
    expect(projectManager.activePageId).toBe(a.id);
  });

  it("switchPage：目标页不存在时静默无操作", () => {
    const { projectManager, controller, events } = make();
    const a = projectManager.createPage("A").meta;
    projectManager.activePageId = a.id;

    controller.switchPage("missing");

    expect(projectManager.activePageId).toBe(a.id);
    expect(events).toEqual([]);
  });

  it("addPage：同步当前场景、创建页面并适配视口", () => {
    const { scene, projectManager, controller, events } = make();
    const a = projectManager.createPage("A").meta;
    projectManager.activePageId = a.id;
    scene.add(createShape("rect", { id: "ra" }));

    const meta = controller.addPage();

    expect(meta).not.toBeNull();
    expect(projectManager.activePageId).toBe(meta!.id);
    expect(projectManager.getPageScene(a.id)?.get("ra")).toBeDefined();
    expect(scene.getAll()).toHaveLength(0);
    expect(events[0]).toBe(`swapped:${meta!.id}:page`);
    expect(events).toContain("viewport:" + meta!.id);
    expect(events).toContain("flush");
  });

  it("loadActivePage：会话恢复路径（视图随快照提供）", () => {
    const { scene, projectManager, controller, events, views } = make();
    controller.loadProject(projectData(), { fullProject: true });
    views["a"] = { zoom: 0.5, panX: 10, panY: 20 };
    events.length = 0;

    controller.loadActivePage({ fullProject: true, views });

    expect(projectManager.activePageId).toBe("a");
    expect(scene.getAll().map((s) => s.id)).toEqual(["s1"]);
    expect(events).toEqual(["swapped:a:full", "viewport:a", "flush"]);
  });

  it("activateViewport：恢复存储视图，fit=false 不改变缩放", () => {
    const { controller, projectManager, views, events } = make();
    const p = projectManager.createPage("P").meta;
    controller.loadProject({
      ...projectData(),
      pages: [{ meta: p, shapes: [] }],
    });
    views[p.id] = { zoom: 0.5, panX: 10, panY: 20 };
    events.length = 0;

    controller.activateViewport(p.id, false);

    expect(views[p.id]).toEqual({ zoom: 0.5, panX: 10, panY: 20 });
    expect(events).toEqual([`viewport:${p.id}`]);
  });

  it("activateViewport：fit=true 且无渲染器时按 1280×800 画布适配", () => {
    const { controller, projectManager, views, events } = make();
    const p = projectManager.createPage("P").meta;
    p.width = 800;
    p.height = 600;
    controller.loadProject({
      ...projectData(),
      pages: [{ meta: p, shapes: [] }],
    });
    events.length = 0;

    controller.activateViewport(p.id, true);

    const vp = views[p.id]!;
    // 适配 1280×800 画布（默认 40px margin）：
    // min((1280-80)/800, (800-80)/600) = min(1.5, 1.2) = 1.2
    expect(vp.zoom).toBeCloseTo(6 / 5, 5);
    expect(events).toEqual([`viewport:${p.id}`]);
  });

  it("绑定索引：加载后整体重建（带绑定的图元进入索引）", () => {
    const { bindingEngine, controller } = make();
    const data = projectData();
    data.pages[0].shapes = [
      {
        id: "s1",
        type: "rect",
        x: 0,
        y: 0,
        bindings: [
          {
            variableId: "VAR_X",
            variableType: "DI",
            targetProp: "fill",
            mapping: { type: "direct" },
            smooth: false,
          },
        ],
      },
    ];
    controller.loadProject(data, { fullProject: true });
    const index = (
      bindingEngine as unknown as { index: Map<string, unknown[]> }
    ).index;
    expect(index.get("VAR_X")?.length).toBe(1);
  });

  it("importShapes：整体替换活动页场景、重置历史、重建索引并适配视口", () => {
    const {
      controller,
      projectManager,
      scene,
      sceneEditor,
      bindingEngine,
      events,
    } = make();
    const p = projectManager.createPage("P").meta;
    controller.loadProject({
      ...projectData(),
      pages: [{ meta: p, shapes: [] }],
    });
    // 先有内容 + 历史
    sceneEditor.addShape({ type: "rect", id: "old" });
    expect(scene.count).toBe(1);
    events.length = 0;

    controller.importShapes([
      createShape("rect", { id: "n1", x: 1, y: 2 }).toJSON(),
      createShape("circle", { id: "n2", x: 3, y: 4 }).toJSON(),
    ]);

    expect(scene.getAll().map((s) => s.id)).toEqual(["n1", "n2"]);
    expect(sceneEditor.undo()).toBeNull(); // 历史已重置
    const index = (
      bindingEngine as unknown as { index: Map<string, unknown[]> }
    ).index;
    expect(index.size).toBe(0);
    expect(events).toEqual([
      `swapped:${p.id}:page`,
      `viewport:${p.id}`,
      "flush",
    ]);
  });
});
