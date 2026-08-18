import { describe, expect, it } from "vitest";
import { SceneGraph } from "../scene";
import {
  GroupShape,
  LineShape,
  PolygonShape,
  PolylineShape,
  createShape,
} from "../shapes";
import {
  getShapeWorldAABB,
  planUngroup,
  unwrapGroup,
  wrapShapesInGroup,
} from "./groupOps";

describe("wrapShapesInGroup", () => {
  it("把多个图元包成组并保持世界位置不变", () => {
    const r1 = createShape("rect", {
      id: "r1",
      x: 100,
      y: 50,
      width: 120,
      height: 80,
      zIndex: 3,
    });
    const r2 = createShape("circle", {
      id: "r2",
      x: 220,
      y: 80,
      width: 55,
      height: 55,
      zIndex: 7,
    });
    const group = wrapShapesInGroup([r1, r2], "进线柜");
    expect(group.type).toBe("group");
    expect(group.x).toBe(100);
    expect(group.y).toBe(50);
    expect(group.width).toBe(175);
    expect(group.height).toBe(85);
    expect(group.zIndex).toBe(7);
    expect(group.name).toBe("进线柜");
    expect(group.children).toHaveLength(2);
    const [c1, c2] = group.children;
    expect(c1.id).not.toBe("r1");
    expect(c1.x).toBe(0);
    expect(c1.y).toBe(0);
    expect(c2.id).not.toBe("r2");
    expect(c2.x).toBe(120);
    expect(c2.y).toBe(30);
  });

  it("少于两个图元时拒绝成组", () => {
    const r1 = createShape("rect", { id: "r1" });
    expect(() => wrapShapesInGroup([r1])).toThrow();
  });
});

describe("unwrapGroup", () => {
  it("应用组的位移与旋转，子图元回到顶层坐标", () => {
    const group = new GroupShape({
      id: "g",
      x: 100,
      y: 50,
      rotation: 90,
      opacity: 0.5,
      zIndex: 5,
      children: [
        createShape("rect", {
          id: "c",
          x: 20,
          y: 10,
          width: 40,
          height: 30,
          opacity: 0.8,
        }).toJSON(),
      ],
    });
    const children = unwrapGroup(group);
    expect(children).toHaveLength(1);
    expect(children[0].x).toBe(90);
    expect(children[0].y).toBe(70);
    expect(children[0].rotation).toBe(90);
    expect(children[0].zIndex).toBe(5);
    expect(children[0].opacity).toBeCloseTo(0.4);
    expect(group.children).toHaveLength(0);
  });

  it("多个子图元按原顺序保持叠放（z 序从组 z 开始递增）", () => {
    const group = new GroupShape({
      id: "g",
      zIndex: 5,
      children: [
        createShape("rect", { id: "a" }).toJSON(),
        createShape("rect", { id: "b" }).toJSON(),
        createShape("rect", { id: "c" }).toJSON(),
      ],
    });
    const children = unwrapGroup(group);
    expect(children.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(children.map((s) => s.zIndex)).toEqual([5, 6, 7]);
  });

  it("组不可见时子图元保持不可见", () => {
    const group = new GroupShape({
      id: "g",
      visible: false,
      children: [createShape("rect", { id: "c", visible: true }).toJSON()],
    });
    const children = unwrapGroup(group);
    expect(children[0].visible).toBe(false);
  });

  it("直线子图元取消成组后点集随组平移到世界坐标", () => {
    const group = new GroupShape({
      id: "g",
      x: 100,
      y: 50,
      children: [
        createShape("line", {
          id: "l",
          startPoint: { x: 10, y: 10 },
          endPoint: { x: 90, y: 10 },
        }).toJSON(),
      ],
    });
    const [line] = unwrapGroup(group) as [LineShape];
    expect(line.startPoint).toEqual({ x: 110, y: 60 });
    expect(line.endPoint).toEqual({ x: 190, y: 60 });
  });

  it("折线/多边形子图元取消成组后点集随组平移到世界坐标", () => {
    const group = new GroupShape({
      id: "g",
      x: 100,
      y: 50,
      children: [
        createShape("polyline", {
          id: "pl",
          points: [
            { x: 10, y: 10 },
            { x: 90, y: 10 },
            { x: 90, y: 40 },
          ],
        }).toJSON(),
        createShape("polygon", {
          id: "pg",
          points: [
            { x: 0, y: 0 },
            { x: 50, y: 0 },
            { x: 25, y: 40 },
          ],
        }).toJSON(),
      ],
    });
    const [polyline, polygon] = unwrapGroup(group) as [
      PolylineShape,
      PolygonShape,
    ];
    expect(polyline.points).toEqual([
      { x: 110, y: 60 },
      { x: 190, y: 60 },
      { x: 190, y: 90 },
    ]);
    expect(polygon.points).toEqual([
      { x: 100, y: 50 },
      { x: 150, y: 50 },
      { x: 125, y: 90 },
    ]);
  });

  it("旋转组的点集子图元按组旋转折算", () => {
    const group = new GroupShape({
      id: "g",
      x: 100,
      y: 50,
      rotation: 90,
      children: [
        createShape("line", {
          id: "l",
          startPoint: { x: 10, y: 10 },
          endPoint: { x: 90, y: 10 },
        }).toJSON(),
        createShape("polyline", {
          id: "pl",
          points: [
            { x: 0, y: 0 },
            { x: 20, y: 0 },
          ],
        }).toJSON(),
      ],
    });
    const [line, polyline] = unwrapGroup(group) as [LineShape, PolylineShape];
    expect(line.startPoint).toEqual({ x: 90, y: 60 });
    expect(line.endPoint).toEqual({ x: 90, y: 140 });
    expect(polyline.points).toEqual([
      { x: 100, y: 50 },
      { x: 100, y: 70 },
    ]);
  });

  it("planUngroup 保留展开前的完整组快照（含子图元）", () => {
    const group = new GroupShape({
      id: "g",
      children: [
        createShape("rect", { id: "c1" }).toJSON(),
        createShape("rect", { id: "c2" }).toJSON(),
      ],
    });
    const plan = planUngroup(group);
    expect(plan.children.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
    expect(plan.groupSnapshot.children?.map((c) => c.id).sort()).toEqual([
      "c1",
      "c2",
    ]);
    expect(group.children).toHaveLength(0);
  });
});

describe("getShapeWorldAABB", () => {
  function sceneWithGroup(children: Record<string, unknown>[]) {
    const scene = new SceneGraph();
    scene.add(
      new GroupShape({
        id: "g",
        x: 100,
        y: 50,
        children: children.map((c) =>
          createShape(c.type as any, c as any).toJSON()
        ),
      })
    );
    return scene;
  }

  it("未旋转组的子图元包围盒直接平移到世界坐标", () => {
    const scene = sceneWithGroup([
      { id: "c", type: "rect", x: 0, y: 0, width: 10, height: 10 },
    ]);
    expect(getShapeWorldAABB(scene, ["g", "c"])).toEqual({
      x: 100,
      y: 50,
      width: 10,
      height: 10,
    });
  });

  it("旋转组的子图元包围盒按组旋转折算", () => {
    const scene = new SceneGraph();
    scene.add(
      new GroupShape({
        id: "g",
        x: 100,
        y: 50,
        rotation: 90,
        children: [
          createShape("rect", {
            id: "c",
            x: 10,
            y: 0,
            width: 10,
            height: 10,
          }).toJSON(),
        ],
      })
    );
    expect(getShapeWorldAABB(scene, ["g", "c"])).toEqual({
      x: 90,
      y: 60,
      width: 10,
      height: 10,
    });
  });

  it("嵌套组的变换逐层叠加", () => {
    const scene = new SceneGraph();
    scene.add(
      new GroupShape({
        id: "g1",
        x: 100,
        y: 50,
        children: [
          new GroupShape({
            id: "g2",
            x: 10,
            y: 10,
            children: [
              createShape("rect", {
                id: "r",
                x: 0,
                y: 0,
                width: 5,
                height: 5,
              }).toJSON(),
            ],
          }).toJSON(),
        ],
      })
    );
    expect(getShapeWorldAABB(scene, ["g1", "g2", "r"])).toEqual({
      x: 110,
      y: 60,
      width: 5,
      height: 5,
    });
  });

  it("非法路径返回 null", () => {
    const scene = new SceneGraph();
    expect(getShapeWorldAABB(scene, ["missing"])).toBeNull();
  });
});
