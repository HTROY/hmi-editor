import { describe, expect, it } from "vitest";
import { RectShape, GroupShape, LineShape, createShape } from ".";
import {
  cloneShapeWithNewIds,
  createLibraryItem,
  getShapeBounds,
  libraryItemToShape,
  offsetShapeProps,
} from "./library";

describe("cloneShapeWithNewIds 深拷贝", () => {
  it("重新生成顶层与嵌套子图元 id，其余字段保持一致", () => {
    const group = createShape("group", {
      id: "g1",
      name: "供电区段",
      children: [
        { id: "c1", type: "rect", x: 0, y: 0, width: 50, height: 50 },
        {
          id: "c2",
          type: "group",
          x: 60,
          y: 0,
          children: [
            { id: "c3", type: "circle", x: 0, y: 0, width: 20, height: 20 },
          ],
        },
      ],
    }).toJSON();
    const clone = cloneShapeWithNewIds(group);
    expect(clone.id).not.toBe(group.id);
    expect(clone.children![0].id).not.toBe(group.children![0].id);
    expect(clone.children![1].id).not.toBe(group.children![1].id);
    expect(clone.children![1].children![0].id).not.toBe(
      group.children![1].children![0].id
    );
    expect(clone.children![1].children![0].type).toBe("circle");
    expect(clone.children![0].width).toBe(50);
    expect(clone.name).toBe("供电区段");
  });
});

describe("getShapeBounds 包围盒", () => {
  it("直线按端点计算", () => {
    const line = new LineShape({
      x: 10,
      y: 20,
      startPoint: { x: 30, y: 40 },
      endPoint: { x: 10, y: 80 },
    }).toJSON();
    expect(getShapeBounds(line)).toEqual({
      x: 10,
      y: 40,
      width: 20,
      height: 40,
    });
  });

  it("组按子图元外接范围计算", () => {
    const group = createShape("group", {
      x: 100,
      y: 200,
      children: [
        { type: "rect", x: -10, y: 0, width: 40, height: 30 },
        { type: "circle", x: 20, y: 5, width: 20, height: 20 },
      ],
    }).toJSON();
    expect(getShapeBounds(group)).toEqual({
      x: 90,
      y: 200,
      width: 50,
      height: 30,
    });
  });
});

describe("offsetShapeProps 平移", () => {
  it("直线平移端点", () => {
    const line = new LineShape({
      startPoint: { x: 1, y: 2 },
      endPoint: { x: 5, y: 6 },
    }).toJSON();
    const moved = offsetShapeProps(line, 10, -2);
    expect(moved.startPoint).toEqual({ x: 11, y: 0 });
    expect(moved.endPoint).toEqual({ x: 15, y: 4 });
  });

  it("矩形平移 x/y，组只平移原点", () => {
    const rect = new RectShape({ x: 1, y: 2 }).toJSON();
    expect(offsetShapeProps(rect, 10, 20)).toMatchObject({ x: 11, y: 22 });
    const group = createShape("group", {
      x: 5,
      y: 6,
      children: [{ type: "rect", x: 0, y: 0, width: 10, height: 10 }],
    }).toJSON();
    const movedGroup = offsetShapeProps(group, 10, 20);
    expect(movedGroup.x).toBe(15);
    expect(movedGroup.y).toBe(26);
    expect(movedGroup.children![0].x).toBe(0);
  });
});

describe("createLibraryItem 库项创建", () => {
  it("单个图元原样保存", () => {
    const rect = new RectShape({ name: "进线柜" });
    const item = createLibraryItem([rect], "进线柜");
    expect(item.name).toBe("进线柜");
    expect(item.shape.type).toBe("rect");
    expect(item.shape.id).toBe(rect.id);
  });

  it("多个图元包成组并归一化相对坐标", () => {
    const a = new RectShape({ x: 100, y: 100, width: 50, height: 40 });
    const b = new RectShape({ x: 170, y: 120, width: 30, height: 30 });
    const item = createLibraryItem([a, b], "组合");
    expect(item.shape.type).toBe("group");
    expect(item.shape.children).toHaveLength(2);
    const children = item.shape.children!;
    expect(children[0].x).toBe(0);
    expect(children[0].y).toBe(0);
    expect(children[1].x).toBe(70);
    expect(children[1].y).toBe(20);
    expect(item.shape.width).toBe(100);
    expect(item.shape.height).toBe(50);
  });

  it("空选择抛出错误", () => {
    expect(() => createLibraryItem([], "空")).toThrow("没有可保存的图元");
  });

  it("指定分组时写入 groupId", () => {
    const rect = new RectShape({ name: "进线柜" });
    const item = createLibraryItem([rect], "进线柜", "grp_1");
    expect(item.groupId).toBe("grp_1");
  });
});

describe("libraryItemToShape 放置副本", () => {
  it("生成全新 id 并居中到指定世界坐标", () => {
    const rect = new RectShape({ x: 50, y: 60, width: 100, height: 80 });
    const item = createLibraryItem([rect], "副本测试");
    const placed = libraryItemToShape(item, 400, 300);
    expect(placed.id).not.toBe(item.shape.id);
    expect(placed.type).toBe("rect");
    expect(placed.x).toBe(350);
    expect(placed.y).toBe(260);
  });

  it("组内子图元 id 全部重新生成", () => {
    const group = new GroupShape({
      children: [
        createShape("rect", { id: "a1", x: 0, y: 0, width: 10, height: 10 }),
        createShape("circle", { id: "a2", x: 20, y: 0, width: 10, height: 10 }),
      ].map((s) => s.toJSON()),
    });
    const item = createLibraryItem([group], "组副本");
    const placed = libraryItemToShape(item, 0, 0) as GroupShape;
    expect(placed.children.map((c) => c.id)).not.toEqual(
      item.shape.children!.map((c) => c.id)
    );
  });
});
