import { ProjectManager } from "../project/ProjectManager";
import { MIN_ZOOM, MAX_ZOOM } from "../view/Viewport";
import {
  AUTOSAVE_SCHEMA_VERSION,
  DEFAULT_PAGE_VIEW,
  type AutosaveSnapshot,
  type PageViewState,
} from "./types";

// ============================================================
// 自动保存快照构建/恢复
// 快照 = 工程数据 + 每页视图状态；恢复时保留最近文件等本地数据
// ============================================================

/** 视图状态归一化：非法/缺失字段回退默认值 */
export function normalizePageView(
  view?: Partial<PageViewState> | null
): PageViewState {
  const finiteNumber = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v);
  const zoom = view?.zoom;
  const panX = view?.panX;
  const panY = view?.panY;
  const validZoom = finiteNumber(zoom) && zoom >= MIN_ZOOM && zoom <= MAX_ZOOM;
  return {
    zoom: validZoom ? zoom : DEFAULT_PAGE_VIEW.zoom,
    panX: finiteNumber(panX) ? panX : DEFAULT_PAGE_VIEW.panX,
    panY: finiteNumber(panY) ? panY : DEFAULT_PAGE_VIEW.panY,
  };
}

/** 为工程全部页面生成默认视图状态 */
export function defaultPageViews(
  project: ProjectManager
): Record<string, PageViewState> {
  const views: Record<string, PageViewState> = {};
  for (const page of project.getPages()) {
    views[page.id] = { ...DEFAULT_PAGE_VIEW };
  }
  return views;
}

/** 构建自动保存快照（视图状态只保留当前工程页面） */
export function buildAutosaveSnapshot(
  project: ProjectManager,
  views: Record<string, PageViewState>,
  activePageId: string
): AutosaveSnapshot {
  const pageIds = new Set(project.getPages().map((p) => p.id));
  const normalizedViews: Record<string, PageViewState> = {};
  for (const pageId of pageIds) {
    normalizedViews[pageId] = normalizePageView(views[pageId]);
  }
  return {
    schemaVersion: AUTOSAVE_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    project: project.exportProject(),
    activePageId: pageIds.has(activePageId)
      ? activePageId
      : project.activePageId,
    views: normalizedViews,
  };
}

/** 把快照恢复到工程管理器，返回恢复后的页面视图 */
export function applyAutosaveSnapshot(
  project: ProjectManager,
  snapshot: AutosaveSnapshot
): Record<string, PageViewState> {
  project.importProject(snapshot.project);
  const pageIds = new Set(project.getPages().map((p) => p.id));
  project.activePageId = pageIds.has(snapshot.activePageId)
    ? snapshot.activePageId
    : project.activePageId;
  const views: Record<string, PageViewState> = {};
  for (const pageId of pageIds) {
    views[pageId] = normalizePageView(snapshot.views[pageId]);
  }
  return views;
}

/** 快照结构校验（自动保存损坏时放弃恢复，不阻塞编辑） */
export function isAutosaveSnapshot(value: unknown): value is AutosaveSnapshot {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<AutosaveSnapshot>;
  return (
    v.schemaVersion === AUTOSAVE_SCHEMA_VERSION &&
    typeof v.savedAt === "string" &&
    !!v.project &&
    Array.isArray(v.project.pages) &&
    typeof v.activePageId === "string" &&
    !!v.views &&
    typeof v.views === "object"
  );
}
