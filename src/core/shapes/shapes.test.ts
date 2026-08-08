import { describe, expect, it } from "vitest";
import {
  createShape,
  PathShape,
  GroupShape,
  ImageShape,
  RectShape,
  PolylineShape,
  PolygonShape,
} from ".";
import type { ShapeProps } from "../types";

describe("createShape 新图元工厂", () => {
  it("path 图元可创建且缺失字段自动补默认值", () => {
    const s = createShape("path", { id: "p1", name: "轨道路径" });
    expect(s).toBeInstanceOf(PathShape);
    expect(s.type).toBe("path");
    expect(s.id).toBe("p1");
    expect(s.name).toBe("轨道路径");
    expect((s as PathShape).d).toBe("M10 10 L90 10 L90 90 L10 90 Z");
    expect(s.x).toBe(0);
    expect(s.width).toBe(100);
    expect(s.fill).toBe("#CCCCCC");
  });

  it("group 图元可创建并从 children 恢复子图元", () => {
    const g = createShape("group", {
      id: "g1",
      name: "供电区段",
      children: [
        { id: "c1", type: "rect", x: 5, y: 6 },
        { id: "c2", type: "path", d: "M0 0 L10 10" },
      ],
    });
    expect(g).toBeInstanceOf(GroupShape);
    expect(g.name).toBe("供电区段");
    expect((g as GroupShape).children).toHaveLength(2);
    expect((g as GroupShape).children[0].id).toBe("c1");
    expect((g as GroupShape).children[0].type).toBe("rect");
    expect((g as GroupShape).children[1].type).toBe("path");
    expect(((g as GroupShape).children[1] as PathShape).d).toBe("M0 0 L10 10");
  });

  it("image 图元可创建且保留图片数据", () => {
    const s = createShape("image", {
      id: "img1",
      src: "data:image/png;base64,AAAA",
    });
    expect(s).toBeInstanceOf(ImageShape);
    expect(s.type).toBe("image");
    expect((s as ImageShape).src).toBe("data:image/png;base64,AAAA");
  });

  it("未知类型回退为矩形，旧工程不会中断", () => {
    const s = createShape("unknown-type" as never, { id: "x1" });
    expect(s).toBeInstanceOf(RectShape);
    expect(s.type).toBe("rect");
  });
});

describe("新图元克隆与序列化", () => {
  it("path 克隆为独立实例且属性一致", () => {
    const s = createShape("path", {
      id: "p1",
      name: "路径",
      d: "M0 0 L50 50",
    }) as PathShape;
    const c = s.clone();
    expect(c).not.toBe(s);
    expect(c).toBeInstanceOf(PathShape);
    expect(c.toJSON()).toEqual(s.toJSON());
    c.d = "M9 9";
    expect(s.d).toBe("M0 0 L50 50");
  });

  it("group 克隆深拷贝子图元", () => {
    const g = createShape("group", {
      id: "g1",
      children: [
        { id: "c1", type: "rect", x: 1, y: 2 },
        { id: "c2", type: "path", d: "M0 0 L5 5" },
      ],
    }) as GroupShape;
    const c = g.clone();
    expect(c).not.toBe(g);
    expect(c.children).toHaveLength(2);
    expect(c.children[0]).not.toBe(g.children[0]);
    expect(c.children[0].x).toBe(1);
    expect(c.toJSON()).toEqual(g.toJSON());
    c.children[0].x = 99;
    expect(g.children[0].x).toBe(1);
  });

  it("image 克隆保留 src", () => {
    const s = createShape("image", {
      id: "i1",
      src: "data:image/png;base64,AA==",
    }) as ImageShape;
    const c = s.clone();
    expect(c).not.toBe(s);
    expect(c.toJSON()).toEqual(s.toJSON());
  });

  it("toJSON/重建往返不丢新图元属性", () => {
    const shapes = [
      createShape("path", {
        id: "p1",
        name: "路径",
        d: "M1 2 L3 4",
        fill: "#123456",
        dashArray: [4, 2],
      }),
      createShape("group", {
        id: "g1",
        name: "组",
        children: [
          { id: "c1", type: "rect", cornerRadius: 5 },
          { id: "c2", type: "image", src: "data:image/png;base64,BB==" },
        ],
      }),
      createShape("image", {
        id: "i1",
        name: "图",
        src: "data:image/png;base64,CC==",
      }),
    ];
    for (const s of shapes) {
      const json = s.toJSON();
      const restored = createShape(json.type, json);
      expect(restored.toJSON()).toEqual(json);
      expect(restored.id).toBe(json.id);
    }
  });

  it("group.fromJSON 将 children 重建为图元实例", () => {
    const g = createShape("group", {
      id: "g1",
      children: [{ id: "c1", type: "rect" }],
    }) as GroupShape;
    g.fromJSON({
      id: "g2",
      type: "group",
      name: "新组",
      children: [{ id: "c2", type: "path", d: "M0 0 L1 1" }],
    } as ShapeProps);
    expect(g.id).toBe("g2");
    expect(g.name).toBe("新组");
    expect(g.children).toHaveLength(1);
    expect(g.children[0]).toBeInstanceOf(PathShape);
    expect((g.children[0] as PathShape).d).toBe("M0 0 L1 1");
  });
});

describe("新图元命中测试", () => {
  it("path 在包围盒内命中、外不命中", () => {
    const s = createShape("path", {
      x: 100,
      y: 100,
      width: 100,
      height: 100,
    }) as PathShape;
    expect(s.hitTest({ x: 150, y: 150 })).toBe(true);
    expect(s.hitTest({ x: 10, y: 10 })).toBe(false);
  });

  it("image 在包围盒内命中、外不命中", () => {
    const s = createShape("image", {
      x: 0,
      y: 0,
      width: 80,
      height: 60,
    }) as ImageShape;
    expect(s.hitTest({ x: 40, y: 30 })).toBe(true);
    expect(s.hitTest({ x: 81, y: 30 })).toBe(false);
  });

  it("group 命中子图元、空组按包围盒判定", () => {
    const g = createShape("group", {
      x: 50,
      y: 50,
      width: 100,
      height: 100,
      children: [
        {
          id: "c1",
          type: "rect",
          x: 10,
          y: 10,
          width: 20,
          height: 20,
        },
      ],
    }) as GroupShape;
    expect(g.hitTest({ x: 65, y: 65 })).toBe(true);
    expect(g.hitTest({ x: 20, y: 20 })).toBe(false);

    const empty = createShape("group", {
      x: 200,
      y: 200,
      width: 100,
      height: 100,
    }) as GroupShape;
    expect(empty.hitTest({ x: 250, y: 250 })).toBe(true);
    expect(empty.hitTest({ x: 10, y: 10 })).toBe(false);
  });
});

describe("polyline/polygon 图元", () => {
  it("可创建、克隆与序列化往返", () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 40, y: 10 },
      { x: 80, y: 0 },
    ];
    const polyline = createShape("polyline", {
      id: "pl1",
      points: pts,
      stroke: "#123456",
    }) as PolylineShape;
    expect(polyline).toBeInstanceOf(PolylineShape);
    expect(polyline.boundingBox).toEqual({ x: 0, y: 0, width: 80, height: 10 });

    const restored = createShape(
      "polyline",
      polyline.toJSON()
    ) as PolylineShape;
    expect(restored.toJSON()).toEqual(polyline.toJSON());
    const clone = polyline.clone() as PolylineShape;
    clone.points[0].x = 99;
    expect(polyline.points[0].x).toBe(0);

    const polygon = createShape("polygon", {
      id: "pg1",
      points: [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 25, y: 40 },
      ],
    }) as PolygonShape;
    expect(polygon).toBeInstanceOf(PolygonShape);
    expect(createShape("polygon", polygon.toJSON()).toJSON()).toEqual(
      polygon.toJSON()
    );
  });

  it("缩放改写点位", () => {
    const polyline = createShape("polyline", {
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 20 },
      ],
    }) as PolylineShape;
    polyline.scale(2, 3);
    expect(polyline.points).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 60 },
    ]);
  });
});
