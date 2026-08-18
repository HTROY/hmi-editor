import { SceneGraph } from "../scene";
import type { Renderer, SceneEditor } from "../scene";
import type { BindingEngine } from "../bindings";
import { Viewport } from "../view";
import { normalizePageView } from "../autosave";
import type { PageViewState } from "../autosave";
import { createShape } from "../shapes";
import type { ShapeProps } from "../types";
import { ProjectManager } from "./ProjectManager";
import type { PageMeta, ProjectData } from "./types";
import { createLogger } from "../platform/logger";

const logger = createLogger("PageController");

/** 一次页面加载/切换的选项 */
export interface PageSwapOptions {
  /** 保留页面撤销历史（页面切换）；缺省重置全部历史（工程级加载） */
  preserveHistory?: boolean;
  /** 工程级替换：刷新图元库并重建页面视图（打开/新建/恢复会话） */
  fullProject?: boolean;
  /** 工程级替换时使用的视图（会话恢复快照）；缺省为全部页面默认视图 */
  views?: Record<string, PageViewState>;
  /** 加载后视口适配页面（打开/新建/新增页面）；缺省恢复该页存储视图 */
  fit?: boolean;
  /** 清除远程工程链接（打开/新建工程） */
  clearRemoteLink?: boolean;
}

export interface PageControllerCallbacks {
  /** 页面已切换：写活动页/清空选中/刷新图元库与视图/递增修订号 */
  onPageSwapped?: (meta: PageMeta, opts: PageSwapOptions) => void;
  /** 视口已激活：持久化 viewport 与该页视图状态 */
  onViewportActivated?: (pageId: string, viewport: Viewport) => void;
  /** 读取该页存储的视图状态（缺失回退默认） */
  getPageView?: (pageId: string) => PageViewState | undefined;
  /** 加载收尾（store：flushAutosave） */
  onFlushAutosave?: () => void;
}

export interface PageControllerOptions {
  scene: SceneGraph;
  sceneEditor: SceneEditor;
  bindingEngine: BindingEngine;
  projectManager: ProjectManager;
  callbacks?: PageControllerCallbacks;
}

/**
 * PageController — 页面加载路径（One page-loading path）
 *
 * 打开/导入、新建、会话恢复、切页、新增页五个入口收敛到同一套
 * 「场景替换 → 历史切换 → 图元库/视图刷新 → 重建绑定索引 → 视口激活 →
 * 重绘 → 自动保存」的加载语义，消除四处复制的 set({...}) 仪式。
 *
 * 页面元数据只以 projectManager 为唯一事实来源：store 的镜像字段
 * （pageTitle/pageWidth/pageHeight/pageBackground）与越界清单都是派生值，
 * 组件直接从 projectManager.getPageMeta(activePageId) 读取。
 *
 * 依赖全部注入（scene / sceneEditor / bindingEngine / projectManager / 回调），
 * 不接触 React 与 store，可通过本模块接口直接测试。
 */
export class PageController {
  private readonly scene: SceneGraph;
  private readonly sceneEditor: SceneEditor;
  private readonly bindingEngine: BindingEngine;
  private readonly projectManager: ProjectManager;
  private readonly callbacks: PageControllerCallbacks;
  private renderer: Renderer | null = null;

  constructor(opts: PageControllerOptions) {
    this.scene = opts.scene;
    this.sceneEditor = opts.sceneEditor;
    this.bindingEngine = opts.bindingEngine;
    this.projectManager = opts.projectManager;
    this.callbacks = opts.callbacks ?? {};
  }

  /** 注入渲染器（画布挂载后调用；视口激活/重绘需要） */
  setRenderer(renderer: Renderer | null): void {
    this.renderer = renderer;
  }

  /** 打开/导入工程：整体替换后加载活动页 */
  loadProject(data: ProjectData, opts: PageSwapOptions = {}): void {
    this.projectManager.importProject(data);
    this.swapToActive(opts);
  }

  /** 新建工程并加载活动页 */
  newProject(opts: PageSwapOptions = {}): void {
    this.projectManager.newProject();
    this.swapToActive(opts);
  }

  /** 加载 projectManager 当前活动页（会话恢复：快照已应用） */
  loadActivePage(opts: PageSwapOptions = {}): void {
    this.swapToActive(opts);
  }

  /**
   * 导入裸图元数组：整体替换当前活动页场景（旧 .json 场景导入路径）。
   * 与 swapToActive 共用同一加载语义：场景替换 → 历史重置 → 镜像刷新 →
   * 重建绑定索引 → 视口适配 → 自动保存。
   */
  importShapes(shapes: ShapeProps[]): void {
    const page = this.projectManager.activePage;
    if (!page) return;
    this.scene.clear();
    for (const sp of shapes) {
      try {
        this.scene.add(createShape(sp.type, sp));
      } catch (e) {
        logger.warn("导入图元失败:", sp.type, e);
      }
    }
    this.sceneEditor.resetHistories(page.meta.id);
    this.callbacks.onPageSwapped?.(page.meta, {});
    this.bindingEngine.rebuildIndex();
    this.activateViewport(page.meta.id, true);
    this.callbacks.onFlushAutosave?.();
  }

  /** 切换页面：先同步当前场景到工程，保留每页历史与视图 */
  switchPage(pageId: string): void {
    const pm = this.projectManager;
    if (pm.activePageId && pm.activePageId !== pageId) {
      pm.syncScene(pm.activePageId, this.scene);
    }
    if (!pm.setActivePage(pageId)) return;
    this.swapToActive({ preserveHistory: true });
  }

  /** 新增页面并切换（视口适配页面） */
  addPage(): PageMeta | null {
    const pm = this.projectManager;
    if (pm.activePageId) pm.syncScene(pm.activePageId, this.scene);
    const { meta } = pm.createPage();
    pm.activePageId = meta.id;
    this.swapToActive({ preserveHistory: true, fit: true });
    return meta;
  }

  /** 激活页面视口：读取存储视图（可选适配页面）后应用到渲染器 */
  activateViewport(pageId: string, fit: boolean): void {
    const meta = this.projectManager.getPageMeta(pageId);
    if (!meta) return;
    const stored = normalizePageView(this.callbacks.getPageView?.(pageId));
    const vp = new Viewport();
    vp.zoom = stored.zoom;
    vp.panX = stored.panX;
    vp.panY = stored.panY;
    if (fit) {
      const r = this.renderer;
      if (r) vp.fitPage(meta.width, meta.height, r.width, r.height);
      else vp.fitPage(meta.width, meta.height, 1280, 800);
    }
    this.renderer?.setViewport(vp);
    this.renderer?.setPage(
      meta.width,
      meta.height,
      meta.background ?? "#FFFFFF"
    );
    this.callbacks.onViewportActivated?.(pageId, vp);
    this.renderer?.render();
  }

  /** 页面加载统一收尾：场景替换 → 历史切换 → 库/视图刷新 → 索引 → 视口 → 保存 */
  private swapToActive(opts: PageSwapOptions): void {
    const f = this.projectManager.activePage;
    if (!f) throw new Error("工程没有页面");
    const meta = f.meta;
    this.scene.clear();
    for (const sh of f.scene.getAll()) this.scene.add(sh);
    if (opts.preserveHistory) this.sceneEditor.activatePage(meta.id);
    else this.sceneEditor.resetHistories(meta.id);
    this.callbacks.onPageSwapped?.(meta, opts);
    this.bindingEngine.rebuildIndex();
    this.activateViewport(meta.id, opts.fit ?? false);
    this.callbacks.onFlushAutosave?.();
  }
}
