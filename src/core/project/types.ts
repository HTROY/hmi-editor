// ============================================================
// 工程管理类型定义
// ============================================================

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
  meta: ProjectMeta;
  pages: {
    meta: PageMeta;
    shapes: any[];
  }[];
}

/** 最近打开的文件 */
export interface RecentFile {
  path: string;
  name: string;
  openedAt: string;
}
