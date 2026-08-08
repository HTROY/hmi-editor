import { SceneGraph } from "../scene/SceneGraph";
import { createShape, ShapeBase } from "../shapes";
import type { PageMeta, ProjectMeta, ProjectData, RecentFile } from "./types";

// ============================================================
// ProjectManager — 工程管理器
// 管理多页面、工程文件导入/导出、最近文件
// ============================================================

export class ProjectManager {
  // 当前工程元信息
  meta: ProjectMeta;

  // 当前激活的页面 ID
  activePageId = "";

  // 页面列表
  private pageMetas: Map<string, PageMeta> = new Map();

  // 每个页面对应的 SceneGraph（按需加载）
  private pageScenes: Map<string, SceneGraph> = new Map();

  // 最近文件列表（存储在 localStorage）
  recentFiles: RecentFile[] = [];

  // 当前文件路径（已保存的）
  currentFilePath = "";

  // 修改标志
  private _dirty = false;
  private dirtyListeners: Set<(dirty: boolean) => void> = new Set();

  constructor() {
    this.meta = this.createDefaultMeta();
    this.loadRecentFiles();
  }

  get dirty(): boolean {
    return this._dirty;
  }

  set dirty(v: boolean) {
    if (this._dirty !== v) {
      this._dirty = v;
      this.dirtyListeners.forEach((cb) => cb(v));
    }
  }

  onDirtyChange(cb: (dirty: boolean) => void): () => void {
    this.dirtyListeners.add(cb);
    return () => this.dirtyListeners.delete(cb);
  }

  // ---- 页面管理 ----

  /** 获取所有页面元数据 */
  getPages(): PageMeta[] {
    return Array.from(this.pageMetas.values()).sort(
      (a, b) => a.order - b.order,
    );
  }

  /** 获取页面元数据 */
  getPageMeta(pageId: string): PageMeta | undefined {
    return this.pageMetas.get(pageId);
  }

  /** 获取页面的场景图 */
  getPageScene(pageId: string): SceneGraph | undefined {
    return this.pageScenes.get(pageId);
  }

  /** 创建新页面 */
  createPage(title?: string): { meta: PageMeta; scene: SceneGraph } {
    const id = "page_" + Date.now().toString(36);
    const now = new Date().toISOString();
    const maxOrder = Math.max(
      0,
      ...Array.from(this.pageMetas.values()).map((p) => p.order),
    );
    const meta: PageMeta = {
      id,
      title: title ?? "新画面",
      width: 1920,
      height: 1080,
      background: this.meta.stationName === "广州地铁" ? "#1A1A2E" : "#FFFFFF",
      order: maxOrder + 1,
      description: "",
      createdAt: now,
      updatedAt: now,
    };
    const scene = new SceneGraph();
    this.pageMetas.set(id, meta);
    this.pageScenes.set(id, scene);
    this.dirty = true;
    return { meta, scene };
  }

  /** 删除页面 */
  deletePage(pageId: string): boolean {
    if (this.pageMetas.size <= 1) return false; // 至少保留一个页面
    const removed = this.pageMetas.delete(pageId);
    this.pageScenes.delete(pageId);
    if (removed && this.activePageId === pageId) {
      // 切换到第一个页面
      const first = this.getPages()[0];
      if (first) this.activePageId = first.id;
    }
    if (removed) this.dirty = true;
    return removed;
  }

  /** 重命名页面 */
  renamePage(pageId: string, newTitle: string): void {
    const meta = this.pageMetas.get(pageId);
    if (meta) {
      meta.title = newTitle;
      meta.updatedAt = new Date().toISOString();
      this.dirty = true;
    }
  }

  /** 设置页面背景色 */
  setPageBackground(pageId: string, background: string): void {
    const meta = this.pageMetas.get(pageId);
    if (meta) {
      meta.background = background;
      meta.updatedAt = new Date().toISOString();
      this.dirty = true;
    }
  }

  /** 移动页面顺序 */
  movePage(pageId: string, newOrder: number): void {
    const meta = this.pageMetas.get(pageId);
    if (!meta) return;
    const pages = this.getPages();
    const oldOrder = meta.order;

    if (newOrder === oldOrder) return;

    for (const p of pages) {
      if (p.id === pageId) {
        p.order = newOrder;
      } else if (newOrder > oldOrder) {
        // 下移：中间页面的 order 减一
        if (p.order > oldOrder && p.order <= newOrder) p.order--;
      } else {
        // 上移
        if (p.order >= newOrder && p.order < oldOrder) p.order++;
      }
    }
    this.dirty = true;
  }

  /** 切换活跃页面 */
  setActivePage(pageId: string): SceneGraph | undefined {
    if (this.pageMetas.has(pageId)) {
      this.activePageId = pageId;
      return this.pageScenes.get(pageId);
    }
    return undefined;
  }

  // ---- 工程导入/导出 ----

  /** 导出当前工程为 ProjectData */
  exportProject(): ProjectData {
    const pages = this.getPages().map((meta) => {
      const scene = this.pageScenes.get(meta.id);
      return {
        meta,
        shapes: scene ? scene.getAll().map((s) => s.toJSON()) : [],
      };
    });

    return {
      meta: { ...this.meta, updatedAt: new Date().toISOString() },
      pages,
    };
  }

  /** 导入工程数据 */
  importProject(data: ProjectData): void {
    // 清空当前
    this.pageMetas.clear();
    this.pageScenes.clear();

    // 导入元信息
    this.meta = { ...data.meta };

    // 导入页面
    for (const pageData of data.pages) {
      const scene = new SceneGraph();
      for (const shapeProps of pageData.shapes) {
        try {
          const shape = createShape(shapeProps.type, shapeProps);
          scene.add(shape);
        } catch (e) {
          console.warn("导入图元失败:", shapeProps.type, e);
        }
      }
      this.pageMetas.set(pageData.meta.id, { ...pageData.meta });
      this.pageScenes.set(pageData.meta.id, scene);
    }

    // 激活第一个页面
    const first = this.getPages()[0];
    if (first) this.activePageId = first.id;

    this.dirty = false;
  }

  /** 导出为 JSON 字符串 */
  toJSON(): string {
    return JSON.stringify(this.exportProject(), null, 2);
  }

  /** 从 JSON 字符串导入 */
  fromJSON(json: string): void {
    const data: ProjectData = JSON.parse(json);
    this.importProject(data);
  }

  /** 导出为 Blob 用于下载 */
  toBlob(): Blob {
    return new Blob([this.toJSON()], { type: "application/json" });
  }

  /** 创建新工程 */
  newProject(): void {
    this.pageMetas.clear();
    this.pageScenes.clear();
    this.meta = this.createDefaultMeta();
    this.currentFilePath = "";
    const { meta, scene } = this.createPage("主画面");
    this.activePageId = meta.id;
    this.dirty = false;
  }

  // ---- 最近文件 ----

  private loadRecentFiles(): void {
    try {
      const stored = localStorage.getItem("hmi_recent_files");
      if (stored) this.recentFiles = JSON.parse(stored);
    } catch {
      /* ignore */
    }
  }

  private saveRecentFiles(): void {
    try {
      localStorage.setItem(
        "hmi_recent_files",
        JSON.stringify(this.recentFiles.slice(0, 10)),
      );
    } catch {
      /* ignore */
    }
  }

  addRecentFile(filePath: string): void {
    this.recentFiles = this.recentFiles.filter((f) => f.path !== filePath);
    this.recentFiles.unshift({
      path: filePath,
      name: this.meta.name,
      openedAt: new Date().toISOString(),
    });
    this.saveRecentFiles();
  }

  /** 获取与新工程文件关联的下载链接 */
  downloadProject(): void {
    const blob = this.toBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = (this.meta.name || "未命名工程") + ".hmi.json";
    a.click();
    URL.revokeObjectURL(url);
    this.dirty = false;
  }

  // ---- 辅助 ----

  private createDefaultMeta(): ProjectMeta {
    return {
      name: "未命名工程",
      version: "0.1.0",
      description: "",
      author: "",
      stationName: "",
      lineName: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  /** 更新当前场景的图元数据到 pageScenes */
  syncScene(pageId: string, scene: SceneGraph): void {
    this.pageScenes.set(pageId, scene);
    this.dirty = true;
  }

  /** 获取当前活跃页面 */
  get activePage(): { meta: PageMeta; scene: SceneGraph } | null {
    const meta = this.pageMetas.get(this.activePageId);
    const scene = this.pageScenes.get(this.activePageId);
    if (meta && scene) return { meta, scene };
    return null;
  }
}
