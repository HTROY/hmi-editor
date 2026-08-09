import type { ProjectData } from "./types";
import { upgradeProjectData } from "./upgrade";
import { createZip, parseZip } from "./zip";

// ============================================================
// package.ts — .hmi.zip 工程包
// 结构：manifest.json（schemaVersion=1，含 assets 清单）
//       + assets/<id>.<ext> 资源文件
// 图元的 src data URL 打包时抽到 assets/，替换为 asset://<id> 引用
// ============================================================

export const PROJECT_PACKAGE_SCHEMA_VERSION = 1;
export const ASSET_REF_PREFIX = "asset://";
export const PACKAGE_MANIFEST_NAME = "manifest.json";

const DEFAULT_MIME = "application/octet-stream";

export interface PackageAsset {
  id: string;
  fileName: string;
  mimeType: string;
}

export interface ProjectPackageManifest {
  schemaVersion: typeof PROJECT_PACKAGE_SCHEMA_VERSION;
  exportedAt: string;
  project: ProjectData;
  assets: PackageAsset[];
}

/** 是否为 .hmi.zip / .zip 工程包文件 */
export function isProjectPackageFile(file: {
  name: string;
  type: string;
}): boolean {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return (
    name.endsWith(".hmi.zip") ||
    name.endsWith(".zip") ||
    type === "application/zip" ||
    type === "application/x-zip-compressed" ||
    type === "multipart/x-zip"
  );
}

/** 从 data URL 头部提取 MIME */
export function dataUrlMime(dataUrl: string): string {
  const match = /^data:([^;,]*)/i.exec(dataUrl);
  return match?.[1] || DEFAULT_MIME;
}

/** MIME → 资源文件扩展名 */
export function mimeToExtension(mime: string): string {
  switch (mime.toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/svg+xml":
      return ".svg";
    case "image/bmp":
      return ".bmp";
    default:
      return ".bin";
  }
}

/** data URL → 字节 */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("无效的 data URL");
  const head = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  if (/;base64$/i.test(head)) {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
  return new TextEncoder().encode(decodeURIComponent(body));
}

/** 字节 → data URL（base64） */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${mime || DEFAULT_MIME};base64,${btoa(binary)}`;
}

type MutableShape = any;

function walkShapes(
  shapes: MutableShape[],
  visit: (shape: MutableShape) => void
): void {
  for (const shape of shapes) {
    visit(shape);
    if (shape && Array.isArray(shape.children)) {
      walkShapes(shape.children, visit);
    }
  }
}

/** 把工程打包为 .hmi.zip 字节流（manifest + assets/ 资源） */
export async function packProjectPackage(
  project: ProjectData
): Promise<Uint8Array> {
  const clone = JSON.parse(JSON.stringify(project)) as ProjectData;
  const assets: PackageAsset[] = [];
  const assetBytes = new Map<string, Uint8Array>();
  const assetIdBySource = new Map<string, string>();

  const register = (src: string): string => {
    const existing = assetIdBySource.get(src);
    if (existing) return existing;
    const mime = dataUrlMime(src);
    const id = `asset_${assets.length + 1}`;
    assetIdBySource.set(src, id);
    assets.push({
      id,
      fileName: `assets/${id}${mimeToExtension(mime)}`,
      mimeType: mime,
    });
    assetBytes.set(id, dataUrlToBytes(src));
    return id;
  };

  walkShapes(
    [
      ...clone.pages.flatMap((page) => page.shapes),
      ...(clone.library ?? []).flatMap((item) =>
        item?.shape ? [item.shape] : []
      ),
    ],
    (shape) => {
      if (typeof shape.src !== "string") return;
      const src = shape.src;
      if (src.startsWith(ASSET_REF_PREFIX) || !src.startsWith("data:")) return;
      shape.src = ASSET_REF_PREFIX + register(src);
    }
  );

  const manifest: ProjectPackageManifest = {
    schemaVersion: PROJECT_PACKAGE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    project: clone,
    assets,
  };
  const encoder = new TextEncoder();
  const entries: { name: string; data: Uint8Array }[] = [
    {
      name: PACKAGE_MANIFEST_NAME,
      data: encoder.encode(JSON.stringify(manifest, null, 2)),
    },
    ...assets.map((asset) => ({
      name: asset.fileName,
      data: assetBytes.get(asset.id)!,
    })),
  ];
  return createZip(entries);
}

function isSafeAssetPath(fileName: string): boolean {
  if (!fileName.startsWith("assets/")) return false;
  return !fileName
    .split("/")
    .some((segment) => segment === "" || segment === "..");
}

/** 解析 .hmi.zip 字节流并还原工程数据（资源引用恢复为 data URL） */
export async function unpackProjectPackage(
  bytes: Uint8Array
): Promise<ProjectData> {
  const files = await parseZip(bytes);
  const manifestRaw = files.get(PACKAGE_MANIFEST_NAME);
  if (!manifestRaw) throw new Error("工程包缺少 manifest.json");

  let manifest: ProjectPackageManifest;
  try {
    manifest = JSON.parse(
      new TextDecoder().decode(manifestRaw)
    ) as ProjectPackageManifest;
  } catch {
    throw new Error("manifest.json 解析失败");
  }
  if (manifest.schemaVersion !== PROJECT_PACKAGE_SCHEMA_VERSION) {
    throw new Error(`不支持的工程包版本: ${String(manifest.schemaVersion)}`);
  }
  if (
    !manifest.project ||
    typeof manifest.project !== "object" ||
    !Array.isArray(manifest.assets)
  ) {
    throw new Error("工程包 manifest 无效");
  }

  const assetsById = new Map<string, PackageAsset>();
  for (const asset of manifest.assets) {
    if (
      !asset ||
      typeof asset.id !== "string" ||
      typeof asset.fileName !== "string" ||
      !isSafeAssetPath(asset.fileName)
    ) {
      throw new Error("工程包资源清单无效");
    }
    assetsById.set(asset.id, asset);
  }

  const project = JSON.parse(JSON.stringify(manifest.project)) as ProjectData;
  const restoreShape = (shape: MutableShape): void => {
    if (!shape || typeof shape !== "object" || typeof shape.src !== "string") {
      return;
    }
    if (!shape.src.startsWith(ASSET_REF_PREFIX)) return;
    const id = shape.src.slice(ASSET_REF_PREFIX.length);
    const asset = assetsById.get(id);
    if (!asset) throw new Error(`工程包缺少资源: ${id}`);
    const data = files.get(asset.fileName);
    if (!data) throw new Error(`工程包资源文件缺失: ${asset.fileName}`);
    shape.src = bytesToDataUrl(
      data,
      typeof asset.mimeType === "string" ? asset.mimeType : DEFAULT_MIME
    );
  };

  for (const page of project.pages ?? []) {
    walkShapes(page.shapes ?? [], restoreShape);
  }
  for (const item of project.library ?? []) {
    if (item?.shape) walkShapes([item.shape], restoreShape);
  }
  return upgradeProjectData(project);
}
