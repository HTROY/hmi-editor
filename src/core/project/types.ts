// ============================================================
// 工程管理类型定义
// ============================================================

import type { LibraryItem } from "../shapes/library";
import type { LibraryGroup, LibraryUi } from "../shapes/libraryGroups";

/** 页面元数据 */
export interface PageMeta {
  id: string;
  title: string;
  width: number;
  height: number;
  background: string;
  order: number; // 显示顺序
  description: string;
  createdAt: string;
  updatedAt: string;
}

/** 工程元信息 */
export interface ProjectMeta {
  name: string;
  version: string;
  description: string;
  author: string;
  stationName: string; // 所属车站
  lineName: string; // 所属线路
  createdAt: string;
  updatedAt: string;
}

/** 完整的工程数据结构 */
export interface ProjectData {
  /** 工程结构版本；旧 .hmi.json 无此字段，导入时按 v1 升级 */
  schemaVersion?: number;
  meta: ProjectMeta;
  pages: {
    meta: PageMeta;
    shapes: any[];
  }[];
  /** 工程图元库（自定义图元条目）；旧工程可缺省 */
  library?: LibraryItem[];
  /** 自定义分组（顺序即显示顺序）；旧工程可缺省 */
  libraryGroups?: LibraryGroup[];
  /** 自定义分组折叠状态等 UI 数据；旧工程可缺省 */
  libraryUi?: LibraryUi;
}

/** 最近打开的文件 */
export interface RecentFile {
  path: string;
  name: string;
  openedAt: string;
}
