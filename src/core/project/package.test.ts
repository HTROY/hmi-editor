import { describe, expect, it } from "vitest";
import type { ProjectData } from "./types";
import { ProjectManager } from "./ProjectManager";
import { createShape } from "../shapes";
import type { ImageShape } from "../shapes";
import {
  PROJECT_PACKAGE_SCHEMA_VERSION,
  packProjectPackage,
  unpackProjectPackage,
} from "./package";
import { createZip, parseZip } from "./zip";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const decoder = new TextDecoder();

function makeProject(): ProjectData {
  return {
    schemaVersion: 1,
    meta: {
      name: "测试工程",
      version: "0.1.0",
      description: "描述",
      author: "作者",
      stationName: "车站",
      lineName: "线路",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    pages: [
      {
        meta: {
          id: "page_1",
          title: "主画面",
          width: 1920,
          height: 1080,
          background: "#FFFFFF",
          order: 1,
          description: "",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        shapes: [
          {
            id: "s1",
            type: "image",
            src: PNG_DATA_URL,
            x: 10,
            y: 20,
            width: 100,
            height: 80,
          },
          {
            id: "g1",
            type: "group",
            x: 0,
            y: 0,
            children: [
              {
                id: "c1",
                type: "image",
                src: PNG_DATA_URL,
                x: 0,
                y: 0,
                width: 10,
                height: 10,
              },
            ],
          },
        ],
      },
    ],
  };
}

describe(".hmi.zip 工程包", () => {
  it("打包后 manifest 含 schemaVersion=1、assets 清单且图元引用 asset://", async () => {
    const bytes = await packProjectPackage(makeProject());
    const files = await parseZip(bytes);

    expect(files.has("manifest.json")).toBe(true);
    expect(files.has("assets/asset_1.png")).toBe(true);

    const manifest = JSON.parse(decoder.decode(files.get("manifest.json")!));
    expect(manifest.schemaVersion).toBe(PROJECT_PACKAGE_SCHEMA_VERSION);
    expect(manifest.assets).toEqual([
      {
        id: "asset_1",
        fileName: "assets/asset_1.png",
        mimeType: "image/png",
      },
    ]);
    expect(manifest.project.pages[0].shapes[0].src).toBe("asset://asset_1");
    expect(manifest.project.pages[0].shapes[1].children[0].src).toBe(
      "asset://asset_1"
    );
  });

  it("相同 data URL 只打包一份资源", async () => {
    const bytes = await packProjectPackage(makeProject());
    const files = await parseZip(bytes);
    const manifest = JSON.parse(decoder.decode(files.get("manifest.json")!));
    expect(manifest.assets).toHaveLength(1);
  });

  it("解包完整还原页面/图元/资源 data URL", async () => {
    const project = makeProject();
    const bytes = await packProjectPackage(project);
    const restored = await unpackProjectPackage(bytes);

    expect(restored.meta).toEqual(project.meta);
    expect(restored.pages[0].meta).toEqual(project.pages[0].meta);
    expect(restored.pages[0].shapes[0].src).toBe(PNG_DATA_URL);
    expect(restored.pages[0].shapes[1].children[0].src).toBe(PNG_DATA_URL);
    expect(restored.pages[0].shapes[1].children[0].type).toBe("image");
  });

  it("解包时缺资源文件抛错", async () => {
    const bytes = await packProjectPackage(makeProject());
    const files = await parseZip(bytes);
    const manifest = JSON.parse(decoder.decode(files.get("manifest.json")!));
    const encoder = new TextEncoder();
    const broken = await createZip([
      {
        name: "manifest.json",
        data: encoder.encode(JSON.stringify(manifest)),
      },
    ]);
    await expect(unpackProjectPackage(broken)).rejects.toThrow(/资源/);
  });

  it("manifest 版本不支持时抛错", async () => {
    const bytes = await packProjectPackage(makeProject());
    const files = await parseZip(bytes);
    const manifest = JSON.parse(decoder.decode(files.get("manifest.json")!));
    manifest.schemaVersion = 99;
    const encoder = new TextEncoder();
    const bad = await createZip([
      {
        name: "manifest.json",
        data: encoder.encode(JSON.stringify(manifest)),
      },
    ]);
    await expect(unpackProjectPackage(bad)).rejects.toThrow(/版本/);
  });

  it("ProjectManager 打包/解包往返", async () => {
    const pm = new ProjectManager();
    pm.newProject();
    const page = pm.activePage!;
    page.scene.add(
      createShape("image", {
        id: "img1",
        src: PNG_DATA_URL,
        x: 5,
        y: 6,
        width: 64,
        height: 64,
      })
    );

    const bytes = await pm.toPackageBytes();
    const restored = new ProjectManager();
    await restored.fromPackageBytes(bytes);

    const scene = restored.getPageScene(page.meta.id);
    const img = scene?.get("img1") as ImageShape | undefined;
    expect(img).toBeDefined();
    expect(img?.src).toBe(PNG_DATA_URL);
    expect(img?.width).toBe(64);
  });
});
