import { createShape } from "../shapes";
import type { PageMeta, ProjectData, ProjectMeta } from "./types";
import type { ShapeProps } from "../types";

// ============================================================
// upgrade.ts — 工程数据 schemaVersion 归一化
// 旧 .hmi.json 没有 schemaVersion 字段，导入时按 v1 升级并补默认值
// ============================================================

/** 当前工程数据版本 */
export const PROJECT_SCHEMA_VERSION = 1;

const now = () => new Date().toISOString();

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;

const stringOr = (v: unknown, fallback: string): string =>
  typeof v === "string" ? v : fallback;

/** 单条图元补默认值（缺失字段由 createShape 工厂补齐） */
function normalizeShapeProps(props: unknown): ShapeProps {
  if (!props || typeof props !== "object") {
    throw new Error("图元数据无效");
  }
  const raw = props as Record<string, unknown>;
  const shape = createShape((raw.type as ShapeProps["type"]) ?? "rect", raw);
  return shape.toJSON();
}

/**
 * 把任意来源的工程数据升级为当前版本：
 * - 无 schemaVersion 视为旧 .hmi.json，按 v1 处理；
 * - meta/页面/图元缺失字段补默认值；
 * - 页面 id 重复时追加后缀保证唯一。
 */
export function upgradeProjectData(value: unknown): ProjectData {
  if (!value || typeof value !== "object") {
    throw new Error("工程数据无效");
  }
  const raw = value as any;
  const schemaVersion = raw.schemaVersion ?? PROJECT_SCHEMA_VERSION;
  if (!isFiniteNumber(schemaVersion) || schemaVersion < 1) {
    throw new Error("工程 schemaVersion 无效");
  }
  if (schemaVersion > PROJECT_SCHEMA_VERSION) {
    throw new Error(
      `工程版本 ${schemaVersion} 高于当前支持的版本 ${PROJECT_SCHEMA_VERSION}`
    );
  }
  if (!Array.isArray(raw.pages)) {
    throw new Error("工程缺少页面数据");
  }

  const meta: ProjectMeta = {
    name: isNonEmptyString(raw.meta?.name) ? raw.meta.name : "未命名工程",
    version: isNonEmptyString(raw.meta?.version) ? raw.meta.version : "0.1.0",
    description: stringOr(raw.meta?.description, ""),
    author: stringOr(raw.meta?.author, ""),
    stationName: stringOr(raw.meta?.stationName, ""),
    lineName: stringOr(raw.meta?.lineName, ""),
    createdAt: stringOr(raw.meta?.createdAt, now()),
    updatedAt: stringOr(raw.meta?.updatedAt, now()),
  };

  const seenIds = new Set<string>();
  const pages = raw.pages.map((pageData: any, index: number) => {
    if (!pageData || typeof pageData !== "object") {
      throw new Error("页面数据无效");
    }
    const p = pageData.meta ?? {};
    let id = isNonEmptyString(p.id) ? p.id : `page_${index + 1}`;
    if (seenIds.has(id)) {
      let suffix = 2;
      while (seenIds.has(`${id}_${suffix}`)) suffix++;
      id = `${id}_${suffix}`;
    }
    seenIds.add(id);

    const pageMeta: PageMeta = {
      id,
      title: isNonEmptyString(p.title) ? p.title : `未命名画面${index + 1}`,
      width: isFiniteNumber(p.width) ? p.width : 1920,
      height: isFiniteNumber(p.height) ? p.height : 1080,
      background: isNonEmptyString(p.background) ? p.background : "#FFFFFF",
      order: isFiniteNumber(p.order) ? p.order : index + 1,
      description: stringOr(p.description, ""),
      createdAt: stringOr(p.createdAt, now()),
      updatedAt: stringOr(p.updatedAt, now()),
    };

    const shapes = (Array.isArray(pageData.shapes) ? pageData.shapes : [])
      .filter((s: unknown) => !!s)
      .map((s: unknown) => {
        try {
          return normalizeShapeProps(s);
        } catch (e) {
          console.warn("导入图元失败:", e);
          return null;
        }
      })
      .filter((s: unknown): s is ShapeProps => !!s);

    return { meta: pageMeta, shapes };
  });

  return { schemaVersion: PROJECT_SCHEMA_VERSION, meta, pages };
}
