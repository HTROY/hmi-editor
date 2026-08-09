import { describe, expect, it } from "vitest";
import { PROJECT_SCHEMA_VERSION, upgradeProjectData } from "./upgrade";

describe("旧 .hmi.json 自动升级", () => {
  it("图元库条目补默认值并保留", () => {
    const upgraded = upgradeProjectData({
      schemaVersion: 1,
      meta: {},
      pages: [{ meta: {}, shapes: [] }],
      library: [
        { id: "lib_1", name: "通风机组", shape: { id: "x", type: "rect" } },
      ],
    });

    expect(upgraded.library).toHaveLength(1);
    const item = upgraded.library![0];
    expect(item.id).toBe("lib_1");
    expect(item.name).toBe("通风机组");
    expect(item.shape.type).toBe("rect");
    expect(item.shape.x).toBe(0);
    expect(item.shape.width).toBe(100);
    expect(typeof item.createdAt).toBe("string");
    expect(typeof item.updatedAt).toBe("string");
  });

  it("图元库条目 id 重复时追加后缀", () => {
    const upgraded = upgradeProjectData({
      schemaVersion: 1,
      meta: {},
      pages: [{ meta: {}, shapes: [] }],
      library: [
        { id: "lib_1", name: "A", shape: { type: "rect" } },
        { id: "lib_1", name: "B", shape: { type: "circle" } },
      ],
    });

    expect(upgraded.library!.map((i) => i.id)).toEqual(["lib_1", "lib_1_2"]);
  });

  it("无 schemaVersion 的旧工程按 v1 导入并补 meta/页面默认值", () => {
    const legacy = {
      meta: { name: "旧工程" },
      pages: [
        {
          meta: { id: "old", title: "旧画面" },
          shapes: [{ id: "r1", type: "rect", x: 10 }],
        },
      ],
    };

    const upgraded = upgradeProjectData(legacy);

    expect(upgraded.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(upgraded.meta).toMatchObject({
      name: "旧工程",
      version: "0.1.0",
      description: "",
      author: "",
      stationName: "",
      lineName: "",
    });
    expect(typeof upgraded.meta.createdAt).toBe("string");
    expect(upgraded.pages[0].meta).toMatchObject({
      id: "old",
      title: "旧画面",
      width: 1920,
      height: 1080,
      background: "#FFFFFF",
      order: 1,
      description: "",
    });
    expect(typeof upgraded.pages[0].meta.createdAt).toBe("string");
  });

  it("图元缺失字段补默认值", () => {
    const upgraded = upgradeProjectData({
      schemaVersion: 1,
      meta: {},
      pages: [{ meta: {}, shapes: [{ id: "r1", type: "rect" }] }],
    });

    const shape = upgraded.pages[0].shapes[0] as any;
    expect(shape.type).toBe("rect");
    expect(shape.x).toBe(0);
    expect(shape.y).toBe(0);
    expect(shape.width).toBe(100);
    expect(shape.height).toBe(100);
    expect(shape.opacity).toBe(1);
    expect(shape.visible).toBe(true);
    expect(shape.locked).toBe(false);
    expect(shape.zIndex).toBe(0);
    expect(shape.fill).toBe("#CCCCCC");
    expect(shape.stroke).toBe("#000000");
    expect(shape.bindings).toEqual([]);
    expect(shape.events).toEqual([]);
  });

  it("页面 id 重复时追加后缀保证唯一", () => {
    const upgraded = upgradeProjectData({
      schemaVersion: 1,
      meta: {},
      pages: [
        { meta: { id: "dup" }, shapes: [] },
        { meta: { id: "dup" }, shapes: [] },
      ],
    });
    expect(upgraded.pages.map((p) => p.meta.id)).toEqual(["dup", "dup_2"]);
  });

  it("旧动画补默认参数", () => {
    const upgraded = upgradeProjectData({
      schemaVersion: 1,
      meta: {},
      pages: [
        {
          meta: {},
          shapes: [
            {
              id: "a1",
              type: "rect",
              animations: [{ type: "blink", enabled: true, speed: 2 }],
            },
          ],
        },
      ],
    });
    expect(upgraded.pages[0].shapes[0].animations).toEqual([
      {
        id: expect.any(String),
        type: "blink",
        enabled: true,
        speed: 2,
        params: { frequency: 1, minOpacity: 0.2 },
        bind: null,
      },
    ]);
  });

  it("未知图元类型回退为矩形而不中断", () => {
    const upgraded = upgradeProjectData({
      schemaVersion: 1,
      meta: {},
      pages: [{ meta: {}, shapes: [{ id: "u1", type: "warp-drive" }] }],
    });
    expect(upgraded.pages[0].shapes[0].type).toBe("rect");
  });

  it("更高版本或缺失页面抛错", () => {
    expect(() =>
      upgradeProjectData({
        schemaVersion: 99,
        meta: {},
        pages: [],
      })
    ).toThrow(/版本/);
    expect(() =>
      upgradeProjectData({
        schemaVersion: 1,
        meta: {},
      })
    ).toThrow(/页面/);
  });
});
