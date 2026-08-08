import { describe, expect, it } from "vitest";
import { Serializer } from "./Serializer";
import { SceneGraph } from "../scene";
import { createShape, PathShape, GroupShape } from "../shapes";
import type { PageData } from "./Serializer";

describe("Serializer 新图元往返", () => {
  it("页面导出/导入保留 path/group/image 全部属性", () => {
    const scene = new SceneGraph();
    scene.add(
      createShape("path", {
        id: "p1",
        name: "接触网",
        d: "M5 5 H95 V55 H5 Z",
        strokeWidth: 3,
      })
    );
    scene.add(
      createShape("group", {
        id: "g1",
        name: "馈线组",
        children: [
          { id: "c1", type: "rect", x: 10, y: 20, cornerRadius: 6 },
          { id: "c2", type: "image", src: "data:image/png;base64,AA==" },
        ],
      })
    );
    scene.add(
      createShape("image", {
        id: "i1",
        name: "站厅平面图",
        src: "data:image/png;base64,BB==",
      })
    );

    const page = Serializer.exportPage(scene, { id: "pg1", title: "主接线" });
    const restored = Serializer.importPage(page);

    expect(restored.count).toBe(3);
    expect(restored.getAll().map((s) => s.toJSON())).toEqual(page.shapes);
    const group = restored.get("g1") as GroupShape;
    expect(group.children).toHaveLength(2);
    expect(group.children[1].type).toBe("image");
  });
});

describe("Serializer 旧工程兼容", () => {
  it("旧工程缺少新图元字段时导入不报错并补默认值", () => {
    const page: PageData = {
      id: "old",
      title: "旧画面",
      width: 800,
      height: 600,
      background: "#FFFFFF",
      shapes: [
        { id: "r1", type: "rect" } as never,
        { id: "l1", type: "line" } as never,
        { id: "p1", type: "path" } as never,
      ],
    };
    const scene = Serializer.importPage(page);
    expect(scene.count).toBe(3);
    expect(scene.get("r1")!.name).toBe("rect");
    expect((scene.get("p1") as PathShape).d).toBeTruthy();
  });

  it("未知图元类型回退为矩形而不是抛错", () => {
    const page: PageData = {
      id: "old",
      title: "旧画面",
      width: 100,
      height: 100,
      background: "#FFFFFF",
      shapes: [{ id: "u1", type: "warp-drive" } as never],
    };
    const scene = Serializer.importPage(page);
    expect(scene.get("u1")!.type).toBe("rect");
  });

  it("group 的 children 为 null/非数组时按空组导入", () => {
    const page: PageData = {
      id: "old",
      title: "旧画面",
      width: 100,
      height: 100,
      background: "#FFFFFF",
      shapes: [
        { id: "g1", type: "group", children: null } as never,
        { id: "g2", type: "group", children: "oops" } as never,
      ],
    };
    const scene = Serializer.importPage(page);
    expect(scene.count).toBe(2);
    expect((scene.get("g1") as GroupShape).children).toEqual([]);
    expect((scene.get("g2") as GroupShape).children).toEqual([]);
  });

  it("页面缺 shapes 或含 null 条目时按空场景导入而不报错", () => {
    const missingShapes: PageData = {
      id: "old",
      title: "旧画面",
      width: 800,
      height: 600,
      background: "#FFFFFF",
    } as never;
    expect(Serializer.importPage(missingShapes).count).toBe(0);

    const withNull = {
      ...missingShapes,
      shapes: [null, { id: "r1", type: "rect" }, undefined],
    } as never;
    const scene = Serializer.importPage(withNull);
    expect(scene.count).toBe(1);
    expect(scene.get("r1")!.type).toBe("rect");
  });
});
