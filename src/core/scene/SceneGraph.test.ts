import { describe, expect, it } from "vitest";
import { createShape } from "../shapes";
import { SceneGraph } from "./SceneGraph";

describe("SceneGraph.getInRect 框选查询", () => {
  it("返回与矩形相交的可见未锁定图元", () => {
    const sg = new SceneGraph();
    const a = createShape("rect", {
      id: "a",
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    const b = createShape("rect", {
      id: "b",
      x: 200,
      y: 0,
      width: 50,
      height: 50,
    });
    sg.add(a);
    sg.add(b);
    const hits = sg.getInRect({ x: 50, y: 0, width: 100, height: 50 });
    expect(hits.map((s) => s.id)).toEqual(["a"]);
  });

  it("排除锁定与不可见图元", () => {
    const sg = new SceneGraph();
    const a = createShape("rect", {
      id: "a",
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    const locked = createShape("rect", {
      id: "locked",
      x: 0,
      y: 0,
      width: 50,
      height: 50,
    });
    locked.locked = true;
    const hidden = createShape("rect", {
      id: "hidden",
      x: 0,
      y: 0,
      width: 20,
      height: 20,
    });
    hidden.visible = false;
    sg.add(a);
    sg.add(locked);
    sg.add(hidden);
    const hits = sg.getInRect({ x: 0, y: 0, width: 100, height: 50 });
    expect(hits.map((s) => s.id)).toEqual(["a"]);
  });
});

describe("SceneGraph.hitTest 动画命中", () => {
  it("move 动画：命中位移后的可见位置，静态位置不再命中", () => {
    const sg = new SceneGraph();
    const r = createShape("rect", {
      id: "r",
      x: 100,
      y: 100,
      width: 50,
      height: 50,
    });
    sg.add(r);
    const anim = new Map([["r", { dx: 100 }]]);
    expect(sg.hitTest(125, 125)).toBe(r);
    expect(sg.hitTest(225, 125)).toBeNull();
    expect(sg.hitTest(225, 125, anim)).toBe(r);
    expect(sg.hitTest(125, 125, anim)).toBeNull();
  });

  it("rotate 动画：命中旋转后的可见区域", () => {
    const sg = new SceneGraph();
    const r = createShape("rect", {
      id: "r",
      x: 0,
      y: 0,
      width: 100,
      height: 50,
    });
    sg.add(r);
    const anim = new Map([["r", { rotation: 90 }]]);
    // 旋转 90° 后：原 (0,50) 角转到 (75,25)，原 (100,0) 角转到 (75,75)
    expect(sg.hitTest(75, 25, anim)).toBe(r);
    expect(sg.hitTest(10, 10, anim)).toBeNull();
  });
});

describe("SceneGraph 结构版本", () => {
  it("增删/插入/清空/标记脏都会递增 version（供图元树重建）", () => {
    const sg = new SceneGraph();
    const v0 = sg.version;
    sg.add(createShape("rect", { id: "r1" }));
    expect(sg.version).toBeGreaterThan(v0);

    const v1 = sg.version;
    sg.remove("r1");
    expect(sg.version).toBeGreaterThan(v1);

    const v2 = sg.version;
    sg.add(createShape("rect", { id: "r2" }));
    sg.insertAt(createShape("rect", { id: "r3" }), 0);
    sg.clear();
    expect(sg.version).toBeGreaterThan(v2);

    const v3 = sg.version;
    sg.markDirty();
    expect(sg.version).toBeGreaterThan(v3);
  });
});
