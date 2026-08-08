import { describe, expect, it } from "vitest";
import {
  CircleShape,
  GroupShape,
  LineShape,
  PathShape,
  PolygonShape,
  PolylineShape,
  RectShape,
  TextShape,
} from "../shapes";
import { importSvg } from "./SvgImporter";

function svg(body: string, viewBox = "0 0 200 100"): string {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
    viewBox +
    '">' +
    body +
    "</svg>"
  );
}

function closeTo(a: number | undefined, b: number, eps = 0.01): void {
  expect(Math.abs((a ?? 0) - b)).toBeLessThan(eps);
}

describe("SVG 导入：基础形状", () => {
  it("rect 保留位置/尺寸/填充/描边/透明度并居中追加", () => {
    const result = importSvg(
      svg(
        '<rect x="10" y="20" width="80" height="40" fill="#ff0000" stroke="#00ff00" stroke-width="3" opacity="0.5"/>'
      ),
      { pageWidth: 1000, pageHeight: 800 }
    );
    expect(result.shapes).toHaveLength(1);
    const rect = result.shapes[0] as RectShape;
    expect(rect.type).toBe("rect");
    closeTo(rect.x, 460);
    closeTo(rect.y, 380);
    expect(rect.width).toBe(80);
    expect(rect.height).toBe(40);
    expect(rect.fill).toBe("#ff0000");
    expect(rect.stroke).toBe("#00ff00");
    expect(rect.strokeWidth).toBe(3);
    expect(rect.opacity).toBe(0.5);
  });

  it("path/polyline/polygon 正确转换", () => {
    const result = importSvg(
      svg(
        '<path d="M10 10 L90 10 L90 90 Z" fill="#123456"/>' +
          '<polyline points="10,110 50,150 90,110" fill="none" stroke="#333333" stroke-width="2"/>' +
          '<polygon points="110,10 190,10 150,80" fill="#abcdef"/>',
        "0 0 300 200"
      ),
      { pageWidth: 1000, pageHeight: 800, center: false }
    );
    expect(result.shapes).toHaveLength(3);

    const path = result.shapes[0] as PathShape;
    expect(path.type).toBe("path");
    expect(path.width).toBe(80);
    expect(path.height).toBe(80);
    expect(path.d).toContain("M0 0");
    expect(path.fill).toBe("#123456");

    const polyline = result.shapes[1] as PolylineShape;
    expect(polyline.type).toBe("polyline");
    expect(polyline.points[0]).toEqual({ x: 0, y: 0 });
    expect(polyline.points[1]).toEqual({ x: 40, y: 40 });
    expect(polyline.fill).toBe("transparent");
    expect(polyline.stroke).toBe("#333333");
    expect(polyline.strokeWidth).toBe(2);

    const polygon = result.shapes[2] as PolygonShape;
    expect(polygon.type).toBe("polygon");
    expect(polygon.points).toEqual([
      { x: 0, y: 0 },
      { x: 80, y: 0 },
      { x: 40, y: 70 },
    ]);
    expect(polygon.fill).toBe("#abcdef");
  });

  it("line 端点转换", () => {
    const result = importSvg(
      svg(
        '<line x1="0" y1="0" x2="100" y2="50" stroke="#000" stroke-width="4"/>'
      ),
      { pageWidth: 1000, pageHeight: 800, center: false }
    );
    const line = result.shapes[0] as LineShape;
    expect(line.type).toBe("line");
    expect(line.startPoint).toEqual({ x: 0, y: 0 });
    expect(line.endPoint).toEqual({ x: 100, y: 50 });
    expect(line.strokeWidth).toBe(4);
  });

  it("circle/ellipse 转换", () => {
    const result = importSvg(
      svg('<circle cx="100" cy="50" r="25" fill="#00aa00"/>', "0 0 200 100"),
      { pageWidth: 1000, pageHeight: 800, center: false }
    );
    const circle = result.shapes[0] as CircleShape;
    expect(circle.type).toBe("circle");
    expect(circle.width).toBe(50);
    expect(circle.height).toBe(50);
    closeTo(circle.x, 75);
    closeTo(circle.y, 25);
  });
});

describe("SVG 导入：文本", () => {
  it("文本转为可编辑 TextShape 且保留字体与填充", () => {
    const result = importSvg(
      svg(
        '<text x="100" y="50" font-size="24" font-family="Arial" fill="#ffffff" text-anchor="middle">站台门</text>'
      ),
      { pageWidth: 1000, pageHeight: 800, center: false }
    );
    const text = result.shapes[0] as TextShape;
    expect(text).toBeInstanceOf(TextShape);
    expect(text.text).toBe("站台门");
    expect(text.fontSize).toBe(24);
    expect(text.fontFamily).toBe("Arial");
    expect(text.fill).toBe("#ffffff");
    expect(text.textAlign).toBe("center");
    // 可编辑：改文本后序列化往返保留
    text.text = "可编辑文本";
    expect(text.toJSON().text).toBe("可编辑文本");
  });
});

describe("SVG 导入：分组与 transform", () => {
  it("g 转为 GroupShape，子图元坐标相对组原点", () => {
    const result = importSvg(
      svg(
        '<g transform="translate(100,50)" fill="#00aaff">' +
          '<rect x="10" y="10" width="30" height="20"/>' +
          '<circle cx="60" cy="20" r="10"/>' +
          "</g>",
        "0 0 400 300"
      ),
      { pageWidth: 1000, pageHeight: 800 }
    );
    expect(result.shapes).toHaveLength(1);
    const group = result.shapes[0] as GroupShape;
    expect(group.type).toBe("group");
    expect(group.children).toHaveLength(2);
    closeTo(group.x, 470);
    closeTo(group.y, 390);
    const rect = group.children[0] as RectShape;
    expect(rect.type).toBe("rect");
    closeTo(rect.x, 0);
    closeTo(rect.y, 0);
    expect(rect.fill).toBe("#00aaff");
    const circle = group.children[1] as CircleShape;
    closeTo(circle.x, 40);
    closeTo(circle.y, 0);
  });

  it("旋转矩形保留 rotation 与中心", () => {
    const result = importSvg(
      svg(
        '<rect x="50" y="50" width="100" height="50" transform="rotate(90 100 75)" fill="#112233"/>',
        "0 0 200 200"
      ),
      { pageWidth: 1000, pageHeight: 800, center: false }
    );
    const rect = result.shapes[0] as RectShape;
    expect(rect.type).toBe("rect");
    closeTo(rect.rotation, 90);
    closeTo(rect.x, 50);
    closeTo(rect.y, 50);
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(50);
  });

  it("含倾斜的矩形回退为路径且不报错", () => {
    const result = importSvg(
      svg('<rect x="0" y="0" width="100" height="50" transform="skewX(30)"/>'),
      { pageWidth: 1000, pageHeight: 800, center: false }
    );
    expect(result.shapes[0]).toBeInstanceOf(PathShape);
  });
});

describe("SVG 导入：渐变", () => {
  it("线性渐变解析为 objectBoundingBox 单位", () => {
    const result = importSvg(
      svg(
        '<defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="0">' +
          '<stop offset="0%" stop-color="#ff0000"/>' +
          '<stop offset="100%" stop-color="#0000ff"/>' +
          "</linearGradient></defs>" +
          '<rect x="0" y="0" width="100" height="50" fill="url(#g1)"/>'
      ),
      { pageWidth: 1000, pageHeight: 800, center: false }
    );
    const rect = result.shapes[0] as RectShape;
    expect(rect.fillGradient?.type).toBe("linear");
    const g = rect.fillGradient;
    if (g?.type === "linear") {
      expect(g.x1).toBe(0);
      closeTo(g.x2, 1);
    }
    expect(rect.fillGradient?.stops.map((s) => s.color)).toEqual([
      "#ff0000",
      "#0000ff",
    ]);
    expect(rect.fill).toBe("#ff0000");
  });

  it("userSpaceOnUse 径向渐变折算到包围盒单位", () => {
    const result = importSvg(
      svg(
        '<defs><radialGradient id="rg" cx="50" cy="50" r="50" gradientUnits="userSpaceOnUse">' +
          '<stop offset="0" stop-color="#ffffff"/>' +
          '<stop offset="1" stop-color="#000000"/>' +
          "</radialGradient></defs>" +
          '<circle cx="50" cy="50" r="50" fill="url(#rg)"/>'
      ),
      { pageWidth: 1000, pageHeight: 800, center: false }
    );
    const circle = result.shapes[0] as CircleShape;
    const g = circle.fillGradient;
    if (g?.type === "radial") {
      closeTo(g.cx, 0.5);
      closeTo(g.cy, 0.5);
      closeTo(g.r, 0.5);
    } else {
      expect(g?.type).toBe("radial");
    }
  });
});

describe("SVG 导入：不支持特性与警告", () => {
  it("filter/mask/marker 给出警告且不影响其余导入", () => {
    const result = importSvg(
      svg(
        '<rect x="0" y="0" width="50" height="50" fill="red" filter="url(#f)" marker-start="url(#m)"/>' +
          '<path d="M0 60 L100 60" stroke="blue" marker-end="url(#m)" mask="url(#mk)"/>'
      ),
      { pageWidth: 1000, pageHeight: 800 }
    );
    expect(result.shapes).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes("滤镜"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("蒙版"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("marker"))).toBe(true);
  });

  it("缺失渐变引用给出警告并回退", () => {
    const result = importSvg(
      svg('<rect x="0" y="0" width="50" height="50" fill="url(#missing)"/>'),
      { pageWidth: 1000, pageHeight: 800 }
    );
    expect(result.shapes).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("missing"))).toBe(true);
  });

  it("不支持的可见元素跳过并警告", () => {
    const result = importSvg(
      svg('<use href="#x"/><rect x="0" y="0" width="10" height="10"/>'),
      { pageWidth: 1000, pageHeight: 800 }
    );
    expect(result.shapes).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes("use"))).toBe(true);
  });
});

describe("SVG 导入：viewBox 与页面边界", () => {
  it("viewBox 用户单位按 1px=1 逻辑像素", () => {
    const result = importSvg(
      svg('<rect x="0" y="0" width="100" height="50"/>', "0 0 200 100"),
      { pageWidth: 1000, pageHeight: 800, center: false }
    );
    const rect = result.shapes[0] as RectShape;
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(50);
  });

  it("超出页面的图元进入 outOfBounds", () => {
    const result = importSvg(
      svg('<rect x="0" y="0" width="2000" height="1000"/>', "0 0 2000 1000"),
      { pageWidth: 1000, pageHeight: 800, center: false }
    );
    expect(result.outOfBounds).toHaveLength(1);
    expect(result.outOfBounds[0].bbox.width).toBe(2000);
  });

  it("空 SVG / 无可见图元返回空列表", () => {
    const result = importSvg(svg("<defs><linearGradient id='x'/></defs>"), {
      pageWidth: 1000,
      pageHeight: 800,
    });
    expect(result.shapes).toHaveLength(0);
  });
});
