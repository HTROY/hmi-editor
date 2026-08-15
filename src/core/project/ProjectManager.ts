import { SceneGraph } from "../scene/SceneGraph";
import { createShape, ShapeBase } from "../shapes";
import type { LibraryItem } from "../shapes/library";
import type { LibraryGroup, LibraryUi } from "../shapes/libraryGroups";
import type { PageMeta, ProjectMeta, ProjectData, RecentFile } from "./types";
import { PROJECT_SCHEMA_VERSION, upgradeProjectData } from "./upgrade";
import { packProjectPackage, unpackProjectPackage } from "./package";
import { NOOP_STORAGE, noopDownload, systemClock } from "../platform/defaults";
import type { ClockPort, DownloadPort, StoragePort } from "../platform/ports";

export interface RemoteProjectLink {
  id: string;
  name: string;
  version: number;
  linkedAt: string;
}

const REMOTE_LINK_STORAGE_KEY = "hmi_remote_link";

let nextPageSeq = 0;

/** ProjectManager 平台端口：存储 / 下载 / 时钟（浏览器实现在 editor/platform） */
export interface ProjectManagerPorts {
  storage?: StoragePort;
  download?: DownloadPort;
  clock?: ClockPort;
}

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

  // 工程图元库（自定义图元条目，随工程保存/打包）
  private library: LibraryItem[] = [];

  // 自定义分组（顺序即显示顺序，随工程保存）
  private libraryGroups: LibraryGroup[] = [];

  // 自定义分组折叠状态等 UI 数据（随工程保存）
  private libraryUi: LibraryUi = { collapsed: [] };

  // 最近文件列表（存储在 localStorage）
  recentFiles: RecentFile[] = [];

  // 当前文件路径（已保存的）
  currentFilePath = "";

  // 关联的远端工程（同步目标）
  remoteLink: RemoteProjectLink | null = null;

  // 修改标志
  private _dirty = false;
  private dirtyListeners: Set<(dirty: boolean) => void> = new Set();

  // 注入的平台端口（核心层不直接触碰 DOM / localStorage）
  private readonly storage: StoragePort;
  private readonly download: DownloadPort;
  private readonly clock: ClockPort;

  constructor(ports: ProjectManagerPorts = {}) {
    this.storage =
      ports.storage ??
      (typeof localStorage !== "undefined" ? localStorage : NOOP_STORAGE);
    this.download = ports.download ?? noopDownload;
    this.clock = ports.clock ?? systemClock;
    this.meta = this.createDefaultMeta();
    this.loadRecentFiles();
    this.loadRemoteLink();
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
      (a, b) => a.order - b.order
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
    const id =
      "page_" +
      this.clock.now().toString(36) +
      "_" +
      (++nextPageSeq).toString(36);
    const now = this.clock.isoNow();
    const maxOrder = Math.max(
      0,
      ...Array.from(this.pageMetas.values()).map((p) => p.order)
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
      meta.updatedAt = this.clock.isoNow();
      this.dirty = true;
    }
  }

  /** 设置页面背景色 */
  setPageBackground(pageId: string, background: string): void {
    const meta = this.pageMetas.get(pageId);
    if (meta) {
      meta.background = background;
      meta.updatedAt = this.clock.isoNow();
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

  /** 获取工程图元库（浅拷贝，避免外部直接改内部引用） */
  getLibrary(): LibraryItem[] {
    return this.library.map((item) => ({ ...item }));
  }

  /** 整体替换工程图元库 */
  setLibrary(items: LibraryItem[]): void {
    this.library = items.map((item) => ({ ...item }));
    this.dirty = true;
  }

  /** 获取自定义分组（浅拷贝） */
  getLibraryGroups(): LibraryGroup[] {
    return this.libraryGroups.map((g) => ({ ...g }));
  }

  /** 整体替换自定义分组（数组顺序即显示顺序） */
  setLibraryGroups(groups: LibraryGroup[]): void {
    this.libraryGroups = groups.map((g) => ({ ...g }));
    this.dirty = true;
  }

  /** 获取自定义分组 UI 状态（浅拷贝） */
  getLibraryUi(): LibraryUi {
    return { collapsed: [...this.libraryUi.collapsed] };
  }

  /** 整体替换自定义分组 UI 状态 */
  setLibraryUi(ui: LibraryUi): void {
    this.libraryUi = { collapsed: [...(ui?.collapsed ?? [])] };
    this.dirty = true;
  }

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
      schemaVersion: PROJECT_SCHEMA_VERSION,
      meta: { ...this.meta, updatedAt: this.clock.isoNow() },
      pages,
      library: this.library.map((item) => ({ ...item })),
      libraryGroups: this.libraryGroups.map((g) => ({ ...g })),
      libraryUi: this.getLibraryUi(),
    };
  }

  /** 导入工程数据 */
  importProject(data: ProjectData): void {
    const upgraded = upgradeProjectData(data);

    // 清空当前
    this.pageMetas.clear();
    this.pageScenes.clear();

    // 导入元信息
    this.meta = { ...upgraded.meta };

    // 导入图元库
    this.library = (upgraded.library ?? []).map((item) => ({ ...item }));
    this.libraryGroups = (upgraded.libraryGroups ?? []).map((g) => ({
      ...g,
    }));
    this.libraryUi = {
      collapsed: [...(upgraded.libraryUi?.collapsed ?? [])],
    };

    // 导入页面
    for (const pageData of upgraded.pages) {
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

  /** 导出为 .hmi.zip 工程包字节流（含 assets/ 资源） */
  async toPackageBytes(): Promise<Uint8Array> {
    return packProjectPackage(this.exportProject());
  }

  /** 从 .hmi.zip 工程包字节流导入 */
  async fromPackageBytes(bytes: Uint8Array): Promise<void> {
    this.importProject(await unpackProjectPackage(bytes));
  }

  /** 下载 .hmi.zip 工程包 */
  async downloadProjectPackage(): Promise<void> {
    const bytes = await this.toPackageBytes();
    this.download.download(
      (this.meta.name || "未命名工程") + ".hmi.zip",
      bytes,
      "application/zip"
    );
    this.dirty = false;
  }

  /** 创建新工程 */
  newProject(): void {
    this.pageMetas.clear();
    this.pageScenes.clear();
    this.library = [];
    this.libraryGroups = [];
    this.libraryUi = { collapsed: [] };
    this.meta = this.createDefaultMeta();
    this.currentFilePath = "";
    this.setRemoteLink(null);
    const { meta, scene } = this.createPage("主画面");
    this.activePageId = meta.id;
    this.dirty = false;
  }

  // ---- 远端工程关联 ----

  private loadRemoteLink(): void {
    try {
      const raw = this.storage.getItem(REMOTE_LINK_STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as Record<string, unknown>).id === "string" &&
        typeof (parsed as Record<string, unknown>).version === "number"
      ) {
        this.remoteLink = parsed as RemoteProjectLink;
      }
    } catch {
      /* ignore */
    }
  }

  setRemoteLink(link: RemoteProjectLink | null): void {
    this.remoteLink = link;
    try {
      if (!link) {
        this.storage.removeItem(REMOTE_LINK_STORAGE_KEY);
      } else {
        this.storage.setItem(REMOTE_LINK_STORAGE_KEY, JSON.stringify(link));
      }
    } catch {
      /* ignore */
    }
  }

  // ---- 最近文件 ----

  private loadRecentFiles(): void {
    try {
      const stored = this.storage.getItem("hmi_recent_files");
      if (stored) this.recentFiles = JSON.parse(stored);
    } catch {
      /* ignore */
    }
  }

  private saveRecentFiles(): void {
    try {
      this.storage.setItem(
        "hmi_recent_files",
        JSON.stringify(this.recentFiles.slice(0, 10))
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
      openedAt: this.clock.isoNow(),
    });
    this.saveRecentFiles();
  }

  /** 获取与新工程文件关联的下载链接 */
  downloadProject(): void {
    this.download.download(
      (this.meta.name || "未命名工程") + ".hmi.json",
      this.toBlob(),
      "application/json"
    );
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
      createdAt: this.clock.isoNow(),
      updatedAt: this.clock.isoNow(),
    };
  }

  /** 把当前场景快照写入 pageScenes（不共享同一 SceneGraph 实例） */
  syncScene(pageId: string, scene: SceneGraph): void {
    const snapshot = new SceneGraph();
    for (const sh of scene.getAll()) snapshot.add(sh.clone());
    this.pageScenes.set(pageId, snapshot);
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
