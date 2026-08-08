import { describe, expect, it } from "vitest";
import {
  createShape,
  GroupShape,
  LineShape,
  PathShape,
  TextShape,
} from "../shapes";
import {
  applyResize,
  getResizeHandles,
  getRotatedAABB,
  hitTestResizeHandle,
  snapValue,
} from "./resize";

describe("snapValue", () => {
  it("snaps to the 20px grid by default", () => {
    expect(snapValue(37, 20)).toBe(40);
    expect(snapValue(23, 20)).toBe(20);
    expect(snapValue(-17, 20)).toBe(-20);
  });

  it("keeps raw values when disabled or grid is invalid", () => {
    expect(snapValue(37, 20, false)).toBe(37);
    expect(snapValue(37, 0)).toBe(37);
  });
});

describe("getRotatedAABB", () => {
  it("returns the plain bounding box for unrotated shapes", () => {
    const r = createShape("rect", { x: 10, y: 20, width: 100, height: 50 });
    expect(getRotatedAABB(r)).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it("returns the screen-axis-aligned bounding box for a rotated rect", () => {
    const r = createShape("rect", {
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      rotation: 90,
    });
    const aabb = getRotatedAABB(r);
    expect(aabb.x).toBeCloseTo(25);
    expect(aabb.y).toBeCloseTo(-25);
    expect(aabb.width).toBeCloseTo(50);
    expect(aabb.height).toBeCloseTo(100);
  });

  it("rotates a group around its origin", () => {
    const g = createShape("group", {
      x: 10,
      y: 20,
      rotation: 90,
      children: [{ id: "c", type: "rect", x: 5, y: 10, width: 30, height: 20 }],
    }) as GroupShape;
    const aabb = getRotatedAABB(g);
    expect(aabb.x).toBeCloseTo(-20);
    expect(aabb.y).toBeCloseTo(25);
    expect(aabb.width).toBeCloseTo(20);
    expect(aabb.height).toBeCloseTo(30);
  });
});

describe("getResizeHandles", () => {
  it("returns the eight AABB handles in order", () => {
    const r = createShape("rect", { x: 0, y: 0, width: 100, height: 100 });
    const handles = getResizeHandles(r);
    expect(handles.nw).toEqual({ x: 0, y: 0 });
    expect(handles.n).toEqual({ x: 50, y: 0 });
    expect(handles.ne).toEqual({ x: 100, y: 0 });
    expect(handles.e).toEqual({ x: 100, y: 50 });
    expect(handles.se).toEqual({ x: 100, y: 100 });
    expect(handles.s).toEqual({ x: 50, y: 100 });
    expect(handles.sw).toEqual({ x: 0, y: 100 });
    expect(handles.w).toEqual({ x: 0, y: 50 });
  });
});

describe("hitTestResizeHandle", () => {
  it("finds the nearest handle inside the tolerance", () => {
    const r = createShape("rect", { x: 0, y: 0, width: 100, height: 100 });
    expect(hitTestResizeHandle(r, { x: 103, y: 50 }, 6)).toBe("e");
    expect(hitTestResizeHandle(r, { x: 2, y: 3 }, 6)).toBe("nw");
    expect(hitTestResizeHandle(r, { x: 50, y: 50 }, 6)).toBeNull();
  });
});

describe("applyResize — 基本矩形", () => {
  it("resizes from the se handle", () => {
    const r = createShape("rect", { x: 0, y: 0, width: 100, height: 100 });
    applyResize(r, "se", { x: 160, y: 120 }, { snap: false });
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
    expect(r.width).toBe(160);
    expect(r.height).toBe(120);
  });

  it("moves the nw corner and keeps the opposite corner fixed", () => {
    const r = createShape("rect", { x: 0, y: 0, width: 100, height: 100 });
    applyResize(r, "nw", { x: 10, y: 20 }, { snap: false });
    expect(r.x).toBe(10);
    expect(r.y).toBe(20);
    expect(r.width).toBe(90);
    expect(r.height).toBe(80);
  });

  it("snaps the moving edge to the 20px grid", () => {
    const r = createShape("rect", { x: 0, y: 0, width: 100, height: 100 });
    applyResize(r, "se", { x: 137, y: 93 });
    expect(r.width).toBe(140);
    expect(r.height).toBe(100);

    const raw = createShape("rect", { x: 0, y: 0, width: 100, height: 100 });
    applyResize(raw, "se", { x: 137, y: 93 }, { snap: false });
    expect(raw.width).toBe(137);
    expect(raw.height).toBe(93);
  });

  it("keeps at least 1px size and never crosses the anchor", () => {
    const r = createShape("rect", { x: 0, y: 0, width: 100, height: 100 });
    applyResize(r, "nw", { x: 99, y: 99 }, { snap: false });
    expect(r.width).toBe(1);
    expect(r.height).toBe(1);

    const r2 = createShape("rect", { x: 0, y: 0, width: 100, height: 100 });
    applyResize(r2, "se", { x: 0.5, y: 0.5 }, { snap: false });
    expect(r2.width).toBe(1);
    expect(r2.height).toBe(1);
  });

  it("Shift keeps the aspect ratio from the anchor", () => {
    const r = createShape("rect", { x: 0, y: 0, width: 100, height: 100 });
    applyResize(
      r,
      "se",
      { x: 300, y: 120 },
      { snap: false, proportional: true }
    );
    expect(r.width).toBe(300);
    expect(r.height).toBe(300);
  });

  it("Shift on an edge handle scales both axes around the opposite edge", () => {
    const r = createShape("rect", { x: 0, y: 0, width: 100, height: 100 });
    applyResize(r, "e", { x: 150, y: 0 }, { snap: false, proportional: true });
    expect(r.width).toBe(150);
    expect(r.height).toBe(150);
    expect(r.x).toBe(0);
    expect(r.y).toBe(-25);
  });
});

describe("applyResize — 圆/文本/路径", () => {
  it("allows non-uniform ellipse resize", () => {
    const c = createShape("circle", { x: 0, y: 0, width: 80, height: 80 });
    applyResize(c, "se", { x: 150, y: 100 }, { snap: false });
    expect(c.width).toBe(150);
    expect(c.height).toBe(100);
  });

  it("scales text font size with the resize ratio", () => {
    const t = createShape("text", {
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      fontSize: 20,
    }) as TextShape;
    applyResize(t, "se", { x: 150, y: 100 }, { snap: false });
    expect(t.width).toBe(150);
    expect(t.height).toBe(100);
    expect(t.fontSize).toBe(40);

    const t2 = createShape("text", {
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      fontSize: 20,
    }) as TextShape;
    applyResize(t2, "e", { x: 200, y: 0 }, { snap: false });
    expect(t2.fontSize).toBe(40);
  });

  it("scales path data with the box", () => {
    const p = createShape("path", {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      d: "M10 10 L90 10 L90 90 L10 90 Z",
    }) as PathShape;
    applyResize(p, "se", { x: 200, y: 100 }, { snap: false });
    expect(p.width).toBe(200);
    expect(p.height).toBe(100);
    expect(p.d).toBe("M20 10 L180 10 L180 90 L20 90 Z");
  });
});

describe("applyResize — 直线改端点", () => {
  it("moves the endpoint nearest to the dragged handle", () => {
    const l = createShape("line", {
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 100, y: 0 },
    }) as LineShape;
    applyResize(l, "e", { x: 150, y: 30 }, { snap: false });
    expect(l.endPoint).toEqual({ x: 150, y: 0 });
    expect(l.startPoint).toEqual({ x: 0, y: 0 });
  });

  it("keeps the slope when Shift is held", () => {
    const l = createShape("line", {
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 100, y: 50 },
    }) as LineShape;
    applyResize(
      l,
      "se",
      { x: 200, y: 100 },
      { snap: false, proportional: true }
    );
    expect(l.endPoint).toEqual({ x: 200, y: 100 });
  });

  it("keeps the line at least 1px long", () => {
    const l = createShape("line", {
      startPoint: { x: 0, y: 0 },
      endPoint: { x: 100, y: 0 },
    }) as LineShape;
    applyResize(l, "w", { x: 100, y: 0 }, { snap: false });
    expect(Math.abs(l.startPoint.x - l.endPoint.x)).toBe(1);
  });
});

describe("applyResize — 组整体缩放", () => {
  it("scales children and keeps their relative layout", () => {
    const g = createShape("group", {
      x: 0,
      y: 0,
      children: [
        { id: "c", type: "rect", x: 10, y: 10, width: 20, height: 20 },
      ],
    }) as GroupShape;
    applyResize(g, "se", { x: 50, y: 50 }, { snap: false });
    expect(g.x).toBe(-10);
    expect(g.y).toBe(-10);
    const c = g.children[0];
    expect(c.x).toBe(20);
    expect(c.y).toBe(20);
    expect(c.width).toBe(40);
    expect(c.height).toBe(40);
  });

  it("resizes non-uniformly from an edge handle", () => {
    const g = createShape("group", {
      x: 0,
      y: 0,
      children: [
        { id: "c", type: "rect", x: 10, y: 10, width: 20, height: 20 },
      ],
    }) as GroupShape;
    applyResize(g, "e", { x: 40, y: 30 }, { snap: false });
    expect(g.x).toBe(-5);
    expect(g.y).toBe(0);
    const c = g.children[0];
    expect(c.x).toBe(15);
    expect(c.y).toBe(10);
    expect(c.width).toBe(30);
    expect(c.height).toBe(20);
  });
});

describe("applyResize — metro 专用图元等比", () => {
  it("always scales proportionally", () => {
    const b = createShape("metro-breaker", {
      x: 0,
      y: 0,
      width: 40,
      height: 60,
    });
    applyResize(b, "se", { x: 100, y: 200 }, { snap: false });
    expect(b.width).toBeCloseTo(133.333, 1);
    expect(b.height).toBe(200);
  });
});

describe("applyResize — 旋转图元按屏幕轴对齐外接框调整", () => {
  it("solves local dimensions so the AABB matches the dragged handle", () => {
    const r = createShape("rect", {
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      rotation: 90,
    });
    applyResize(r, "se", { x: 100, y: 75 }, { snap: false });
    expect(r.width).toBe(100);
    expect(r.height).toBe(75);
    expect(r.x).toBeCloseTo(12.5);
    expect(r.y).toBeCloseTo(-12.5);
    expect(getRotatedAABB(r).width).toBeCloseTo(75);
    expect(getRotatedAABB(r).height).toBeCloseTo(100);
  });

  it("falls back to uniform scaling at degenerate angles", () => {
    const r = createShape("rect", {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      rotation: 45,
    });
    applyResize(r, "se", { x: 283, y: 141 }, { snap: false });
    expect(r.width).toBeCloseTo(214.76, 1);
    expect(r.height).toBeCloseTo(214.76, 1);
  });
});
