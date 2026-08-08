import { describe, expect, it } from "vitest";
import { SceneGraph } from "./SceneGraph";
import { createShape } from "../shapes";
import type {
  GroupShape,
  LineShape,
  PathShape,
  RectShape,
  TextShape,
} from "../shapes";
import {
  computeScaleFactor,
  scaleShape,
  scaleSceneToPage,
  getOutOfBoundsShapes,
} from "./scaling";

describe("scaleShape", () => {
  it("scales rectangle geometry, stroke, dash and corner radius uniformly", () => {
    const r = createShape("rect", {
      id: "r",
      x: 100,
      y: 50,
      width: 200,
      height: 80,
      strokeWidth: 2,
      dashArray: [4, 2],
      cornerRadius: 8,
    }) as RectShape;
    scaleShape(r, 2);
    expect(r.x).toBe(200);
    expect(r.y).toBe(100);
    expect(r.width).toBe(400);
    expect(r.height).toBe(160);
    expect(r.strokeWidth).toBe(4);
    expect(r.dashArray).toEqual([8, 4]);
    expect(r.cornerRadius).toBe(16);
  });

  it("scales line endpoints and stroke width", () => {
    const l = createShape("line", {
      id: "l",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      startPoint: { x: 10, y: 20 },
      endPoint: { x: 30, y: 40 },
      strokeWidth: 2,
    }) as LineShape;
    scaleShape(l, 3);
    expect(l.startPoint).toEqual({ x: 30, y: 60 });
    expect(l.endPoint).toEqual({ x: 90, y: 120 });
    expect(l.strokeWidth).toBe(6);
  });

  it("scales text font size", () => {
    const t = createShape("text", {
      id: "t",
      x: 10,
      y: 10,
      width: 100,
      height: 50,
      fontSize: 20,
    }) as TextShape;
    scaleShape(t, 0.5);
    expect(t.fontSize).toBe(10);
    expect(t.x).toBe(5);
    expect(t.height).toBe(25);
  });

  it("scales path data coordinates", () => {
    const p = createShape("path", {
      id: "p",
      d: "M10 20 L30 40 H50 V60 Z",
    }) as PathShape;
    scaleShape(p, 2);
    expect(p.d).toBe("M20 40 L60 80 H100 V120 Z");
  });

  it("scales arc radii and endpoints but not rotations or flags", () => {
    const p = createShape("path", {
      id: "p",
      d: "M0 0 A5 10 45 1 1 20 30",
    }) as PathShape;
    scaleShape(p, 2);
    expect(p.d).toBe("M0 0 A10 20 45 1 1 40 60");
  });

  it("scales group children and group origin together", () => {
    const g = createShape("group", {
      id: "g",
      x: 10,
      y: 20,
      width: 100,
      height: 80,
      children: [
        {
          id: "c",
          type: "rect",
          x: 5,
          y: 10,
          width: 30,
          height: 20,
        },
      ],
    }) as GroupShape;
    scaleShape(g, 2);
    expect(g.x).toBe(20);
    expect(g.y).toBe(40);
    const c = g.children[0];
    expect(c.x).toBe(10);
    expect(c.y).toBe(20);
    expect(c.width).toBe(60);
    expect(c.height).toBe(40);
  });
});

describe("computeScaleFactor", () => {
  it("uses the smaller dimension ratio to fit the new resolution", () => {
    expect(computeScaleFactor(1920, 1080, 1280, 720)).toBeCloseTo(2 / 3);
    expect(computeScaleFactor(1920, 1080, 3840, 2160)).toBe(2);
    expect(computeScaleFactor(1000, 1000, 2000, 1500)).toBe(1.5);
  });

  it("returns 1 when dimensions are invalid", () => {
    expect(computeScaleFactor(0, 1080, 1280, 720)).toBe(1);
    expect(computeScaleFactor(1920, 0, 1280, 720)).toBe(1);
  });
});

describe("scaleSceneToPage", () => {
  it("scales every shape proportionally to the new resolution", () => {
    const scene = new SceneGraph();
    scene.add(
      createShape("rect", {
        id: "r",
        x: 100,
        y: 100,
        width: 200,
        height: 100,
      })
    );
    scene.add(
      createShape("circle", {
        id: "c",
        x: 500,
        y: 300,
        width: 80,
        height: 80,
      })
    );
    const factor = scaleSceneToPage(scene, 1920, 1080, 1280, 720);
    expect(factor).toBeCloseTo(2 / 3);
    expect(scene.get("r")!.x).toBeCloseTo((100 * 2) / 3);
    expect(scene.get("c")!.width).toBeCloseTo((80 * 2) / 3);
  });
});

describe("getOutOfBoundsShapes", () => {
  const pageW = 1920;
  const pageH = 1080;

  it("ignores shapes fully inside the page", () => {
    const scene = new SceneGraph();
    scene.add(
      createShape("rect", {
        id: "in",
        x: 100,
        y: 100,
        width: 100,
        height: 100,
      })
    );
    expect(getOutOfBoundsShapes(scene, pageW, pageH)).toHaveLength(0);
  });

  it("reports shapes crossing the right, bottom, left or top edge", () => {
    const scene = new SceneGraph();
    scene.add(
      createShape("rect", {
        id: "right",
        x: 1900,
        y: 100,
        width: 100,
        height: 50,
      })
    );
    scene.add(
      createShape("rect", {
        id: "bottom",
        x: 100,
        y: 1050,
        width: 50,
        height: 100,
      })
    );
    scene.add(
      createShape("rect", { id: "left", x: -20, y: 100, width: 50, height: 50 })
    );
    scene.add(
      createShape("rect", { id: "top", x: 100, y: -10, width: 50, height: 50 })
    );
    const ids = getOutOfBoundsShapes(scene, pageW, pageH)
      .map((s) => s.id)
      .sort();
    expect(ids).toEqual(["bottom", "left", "right", "top"]);
  });

  it("includes the shape name and bounding box for warnings", () => {
    const scene = new SceneGraph();
    scene.add(
      createShape("rect", {
        id: "r",
        name: "母线",
        x: 2000,
        y: 100,
        width: 60,
        height: 40,
      })
    );
    const [o] = getOutOfBoundsShapes(scene, pageW, pageH);
    expect(o).toEqual({
      id: "r",
      name: "母线",
      bbox: { x: 2000, y: 100, width: 60, height: 40 },
    });
  });

  it("checks a group by its combined bounding box", () => {
    const scene = new SceneGraph();
    scene.add(
      createShape("group", {
        id: "g",
        x: 1900,
        y: 100,
        children: [
          { id: "c", type: "rect", x: 0, y: 0, width: 50, height: 50 },
        ],
      })
    );
    expect(getOutOfBoundsShapes(scene, pageW, pageH).map((s) => s.id)).toEqual([
      "g",
    ]);
  });
});
