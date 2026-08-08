import type { ProjectData } from "../project/types";

/** 每页视图状态：缩放与平移，只影响编辑视图，不改变图元坐标 */
export interface PageViewState {
  zoom: number;
  panX: number;
  panY: number;
}

/** 自动保存快照：工程数据 + 每页视图状态（不含选中项/面板/剪贴板等临时 UI 状态） */
export interface AutosaveSnapshot {
  schemaVersion: 1;
  savedAt: string;
  project: ProjectData;
  activePageId: string;
  views: Record<string, PageViewState>;
}

export const AUTOSAVE_SCHEMA_VERSION = 1;

export const DEFAULT_PAGE_VIEW: PageViewState = {
  zoom: 1,
  panX: 0,
  panY: 0,
};
