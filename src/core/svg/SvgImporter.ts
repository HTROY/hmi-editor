import type {
  BoundingBox,
  GradientStop,
  ShapeGradient,
  TransformMatrix,
} from "../types";
import {
  CircleShape,
  GroupShape,
  ImageShape,
  LineShape,
  PathShape,
  PolygonShape,
  PolylineShape,
  RectShape,
  ShapeBase,
  TextShape,
} from "../shapes";
import {
  getPathBounds,
  translatePathData,
  transformPathDataMatrix,
} from "../shapes/pathTransform";
import { getRotatedAABB } from "../scene/resize";
import { capabilityOf } from "../shapes/capability";
import type { OutOfBoundsShape } from "../scene/scaling";
import { normalizeColor, withAlpha } from "./color";
import {
  decomposeRotateScale,
  IDENTITY,
  multiply,
  parseTransform,
  transformPoint,
} from "./transform";
import {
  collectText,
  getAttr,
  getHref,
  parseXml,
  type XmlElement,
} from "./xml";

// ============================================================
// SvgImporter — SVG 矢量导入（core 层，无 DOM 依赖）
// 支持：rect/circle/ellipse/line/path/polyline/polygon/text/image、
// 分组、transform、fill/stroke/透明度、线性/径向渐变、viewBox 1px=1 逻辑像素。
// 不支持：filter/mask/marker/clip-path（给出警告后忽略，不影响其余导入）。
// ============================================================

export interface SvgImportOptions {
  pageWidth: number;
  pageHeight: number;
  /** 默认 true：按整体包围盒居中追加 */
  center?: boolean;
}

export interface SvgImportResult {
  shapes: ShapeBase[];
  warnings: string[];
  outOfBounds: OutOfBoundsShape[];
  bbox: BoundingBox | null;
}

interface SvgStyleCtx {
  fill: string;
  stroke: string;
  strokeWidth: number;
  fillOpacity: number;
  strokeOpacity: number;
  color: string;
  fontSize: number;
  fontFamily: string;
  textAnchor: "start" | "middle" | "end";
  dominantBaseline: string;
  visibility: "visible" | "hidden" | "collapse";
}

interface RawGradient {
  type: "linear" | "radial";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cx: number;
  cy: number;
  r: number;
  fx: number;
  fy: number;
  units: "objectBoundingBox" | "userSpaceOnUse";
  transform: TransformMatrix;
  stops: GradientStop[];
}

interface Paint {
  color: string;
  gradient: ShapeGradient | null;
}

const DEFAULT_STYLE: SvgStyleCtx = {
  fill: "black",
  stroke: "none",
  strokeWidth: 1,
  fillOpacity: 1,
  strokeOpacity: 1,
  color: "#000000",
  fontSize: 16,
  fontFamily: "sans-serif",
  textAnchor: "start",
  dominantBaseline: "auto",
  visibility: "visible",
};

const DEF_TAGS = new Set([
  "defs",
  "filter",
  "mask",
  "marker",
  "pattern",
  "clippath",
  "symbol",
  "lineargradient",
  "radialgradient",
  "metadata",
  "title",
  "desc",
  "style",
]);

function parseLength(value: string | undefined, fallback = 0): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseOpacity(value: string | undefined): number {
  return Math.min(1, Math.max(0, parseLength(value, 1)));
}

function parseFontSize(value: string | undefined, parent: number): number {
  if (!value) return parent;
  const v = value.trim();
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return parent;
  if (v.endsWith("em")) return parent * n;
  if (v.endsWith("%")) return parent * (n / 100);
  if (v.endsWith("pt")) return n * (96 / 72);
  return n;
}

function parseDashArray(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((v) => Number.parseFloat(v))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function parsePoints(value: string | undefined): { x: number; y: number }[] {
  if (!value) return [];
  const nums = value
    .split(/[\s,]+/)
    .map((v) => Number.parseFloat(v))
    .filter((n) => Number.isFinite(n));
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    pts.push({ x: nums[i], y: nums[i + 1] });
  }
  return pts;
}

function parsePercent(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return v.trim().endsWith("%") ? n / 100 : n;
}

function getStyle(el: XmlElement, parent: SvgStyleCtx): SvgStyleCtx {
  const color = getAttr(el, "color") ?? parent.color;
  const fill = getAttr(el, "fill") ?? parent.fill;
  const stroke = getAttr(el, "stroke") ?? parent.stroke;
  const fillOpacityAttr = getAttr(el, "fill-opacity");
  const strokeOpacityAttr = getAttr(el, "stroke-opacity");
  return {
    fill: fill === "inherit" ? parent.fill : fill,
    stroke: stroke === "inherit" ? parent.stroke : stroke,
    strokeWidth: parseLength(getAttr(el, "stroke-width"), parent.strokeWidth),
    fillOpacity:
      fillOpacityAttr !== undefined
        ? parseOpacity(fillOpacityAttr)
        : parent.fillOpacity,
    strokeOpacity:
      strokeOpacityAttr !== undefined
        ? parseOpacity(strokeOpacityAttr)
        : parent.strokeOpacity,
    color,
    fontSize: parseFontSize(getAttr(el, "font-size"), parent.fontSize),
    fontFamily: getAttr(el, "font-family") ?? parent.fontFamily,
    textAnchor:
      (getAttr(el, "text-anchor") as SvgStyleCtx["textAnchor"]) ??
      parent.textAnchor,
    dominantBaseline:
      getAttr(el, "dominant-baseline") ?? parent.dominantBaseline,
    visibility:
      (getAttr(el, "visibility") as SvgStyleCtx["visibility"]) ??
      parent.visibility,
  };
}

function parseStop(el: XmlElement, index: number, stops: number): GradientStop {
  const colorValueRaw = getAttr(el, "stop-color") ?? "black";
  const colorValue = colorValueRaw === "inherit" ? "black" : colorValueRaw;
  const color =
    colorValue === "currentColor"
      ? "#000000"
      : colorValue.startsWith("url(")
        ? "#000000"
        : normalizeColor(colorValue);
  const offset = parsePercent(
    getAttr(el, "offset"),
    index === 0 ? 0 : index === stops - 1 ? 1 : index / Math.max(1, stops - 1)
  );
  const alpha = parseOpacity(getAttr(el, "stop-opacity"));
  return { offset, color: withAlpha(color, alpha) };
}

function parseGradient(el: XmlElement): RawGradient {
  const stops = el.children
    .filter((c) => c.tagName.toLowerCase() === "stop")
    .map((c, i, arr) => parseStop(c, i, arr.length));
  const units =
    getAttr(el, "gradientUnits") === "userSpaceOnUse"
      ? "userSpaceOnUse"
      : "objectBoundingBox";
  const transform = parseTransform(getAttr(el, "gradientTransform"));
  if (el.tagName.toLowerCase() === "lineargradient") {
    return {
      type: "linear",
      x1: parsePercent(getAttr(el, "x1"), 0),
      y1: parsePercent(getAttr(el, "y1"), 0),
      x2: parsePercent(getAttr(el, "x2"), 1),
      y2: parsePercent(getAttr(el, "y2"), 0),
      cx: 0,
      cy: 0,
      r: 0,
      fx: 0,
      fy: 0,
      units,
      transform,
      stops,
    };
  }
  const cx = parsePercent(getAttr(el, "cx"), 0.5);
  const cy = parsePercent(getAttr(el, "cy"), 0.5);
  return {
    type: "radial",
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
    cx,
    cy,
    r: parsePercent(getAttr(el, "r"), 0.5),
    fx: parsePercent(getAttr(el, "fx"), cx),
    fy: parsePercent(getAttr(el, "fy"), cy),
    units,
    transform,
    stops,
  };
}

function collectGradients(root: XmlElement): Map<string, RawGradient> {
  const map = new Map<string, RawGradient>();
  const visit = (el: XmlElement) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "lineargradient" || tag === "radialgradient") {
      const id = getAttr(el, "id");
      if (id) map.set(id, parseGradient(el));
    }
    for (const child of el.children) visit(child);
  };
  visit(root);
  return map;
}

function toShapeGradient(raw: RawGradient, bbox: BoundingBox): ShapeGradient {
  const w = Math.max(1e-6, bbox.width);
  const h = Math.max(1e-6, bbox.height);
  const scaleAvg =
    (Math.hypot(raw.transform.a, raw.transform.b) +
      Math.hypot(raw.transform.c, raw.transform.d)) /
    2;

  if (raw.type === "linear") {
    const apply = (x: number, y: number) => {
      const p = transformPoint(raw.transform, x, y);
      return raw.units === "userSpaceOnUse"
        ? { x: (p.x - bbox.x) / w, y: (p.y - bbox.y) / h }
        : p;
    };
    const p1 = apply(raw.x1, raw.y1);
    const p2 = apply(raw.x2, raw.y2);
    return {
      type: "linear",
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      stops: raw.stops,
    };
  }

  const apply = (x: number, y: number) => {
    const p = transformPoint(raw.transform, x, y);
    return raw.units === "userSpaceOnUse"
      ? { x: (p.x - bbox.x) / w, y: (p.y - bbox.y) / h }
      : p;
  };
  const c = apply(raw.cx, raw.cy);
  const f = apply(raw.fx, raw.fy);
  const r = raw.units === "userSpaceOnUse" ? raw.r / Math.max(w, h) : raw.r;
  return {
    type: "radial",
    cx: c.x,
    cy: c.y,
    r: Math.max(1e-6, r * Math.max(1e-6, scaleAvg)),
    fx: f.x,
    fy: f.y,
    stops: raw.stops,
  };
}

function resolvePaint(
  value: string,
  ctx: SvgStyleCtx,
  kind: "fill" | "stroke",
  gradients: Map<string, RawGradient>,
  bbox: BoundingBox,
  warn: (msg: string) => void
): Paint {
  let v = value;
  if (v === "inherit") v = kind === "fill" ? ctx.fill : ctx.stroke;
  if (v === "currentColor") v = ctx.color;
  if (v === "context-fill") v = ctx.fill;
  if (v === "context-stroke") v = ctx.stroke;
  const m = /^url\(\s*(?:["']?)(#[^)"']+)(?:["']?)\s*\)/i.exec(v.trim());
  if (m) {
    const raw = gradients.get(m[1].slice(1));
    if (!raw) {
      warn("找不到渐变引用 " + m[1] + "，已使用纯色回退");
      return { color: "transparent", gradient: null };
    }
    return {
      color: raw.stops[0]?.color ?? "#000000",
      gradient: toShapeGradient(raw, bbox),
    };
  }
  if (v.trim() === "none") return { color: "transparent", gradient: null };
  return { color: normalizeColor(v), gradient: null };
}

function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      code >= 0x2e80 ||
      /[\u1100-\u11ff\uac00-\ud7af\uf900-\ufaff\uff61-\uff9f]/.test(ch);
    w += wide ? fontSize : fontSize * 0.6;
  }
  return Math.max(1, w);
}

function ellipsePath(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotationDeg: number
): string {
  const K = 0.5522847498;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const raw: [number, number][] = [
    [cx + rx, cy],
    [cx + rx, cy + ry * K],
    [cx + rx * K, cy + ry],
    [cx, cy + ry],
    [cx - rx * K, cy + ry],
    [cx - rx, cy + ry * K],
    [cx - rx, cy],
    [cx - rx, cy - ry * K],
    [cx - rx * K, cy - ry],
    [cx, cy - ry],
    [cx + rx * K, cy - ry],
    [cx + rx, cy - ry * K],
    [cx + rx, cy],
  ];
  const pts = raw.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    return {
      x: cx + dx * cos - dy * sin,
      y: cy + dx * sin + dy * cos,
    };
  });
  const f = (n: number) => String(Math.round(n * 1000) / 1000);
  return (
    "M " +
    f(pts[0].x) +
    " " +
    f(pts[0].y) +
    " C " +
    pts
      .slice(1)
      .map((p) => f(p.x) + " " + f(p.y))
      .join(" ") +
    " Z"
  );
}

function applyPaint(
  shape: ShapeBase,
  style: SvgStyleCtx,
  gradients: Map<string, RawGradient>,
  bbox: BoundingBox,
  warn: (msg: string) => void
): void {
  const fill = resolvePaint(style.fill, style, "fill", gradients, bbox, warn);
  const stroke = resolvePaint(
    style.stroke,
    style,
    "stroke",
    gradients,
    bbox,
    warn
  );
  shape.fill = withAlpha(fill.color, style.fillOpacity);
  shape.fillGradient = fill.gradient;
  shape.stroke = withAlpha(stroke.color, style.strokeOpacity);
  shape.strokeGradient = stroke.gradient;
  shape.strokeWidth = style.strokeWidth;
}

function finalizePath(
  d: string,
  style: SvgStyleCtx,
  gradients: Map<string, RawGradient>,
  opacity: number,
  name: string,
  warn: (msg: string) => void,
  dashArray: number[] = [],
  strokeScale = 1
): PathShape {
  const bounds = getPathBounds(d);
  const shape = new PathShape({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    d: translatePathData(d, -bounds.x, -bounds.y),
    name,
    opacity,
    dashArray,
  });
  applyPaint(shape, style, gradients, bounds, warn);
  shape.strokeWidth *= strokeScale;
  return shape;
}

function translateShape(shape: ShapeBase, dx: number, dy: number): void {
  const points = capabilityOf(shape).points;
  if (points) {
    points.set(
      shape,
      points.get(shape).map((p) => ({ x: p.x + dx, y: p.y + dy }))
    );
  }
  shape.x += dx;
  shape.y += dy;
}

function localizeShape(shape: ShapeBase, ox: number, oy: number): void {
  translateShape(shape, -ox, -oy);
}

function computeBBox(shapes: ShapeBase[]): BoundingBox | null {
  let result: BoundingBox | null = null;
  for (const s of shapes) {
    const bb = getRotatedAABB(s);
    result = result
      ? {
          x: Math.min(result.x, bb.x),
          y: Math.min(result.y, bb.y),
          width:
            Math.max(result.x + result.width, bb.x + bb.width) -
            Math.min(result.x, bb.x),
          height:
            Math.max(result.y + result.height, bb.y + bb.height) -
            Math.min(result.y, bb.y),
        }
      : { ...bb };
  }
  return result;
}

function collectWarnings(el: XmlElement, warn: (msg: string) => void): void {
  const filter = getAttr(el, "filter");
  if (filter) warn("已忽略滤镜 filter=" + filter);
  const mask = getAttr(el, "mask");
  if (mask) warn("已忽略蒙版 mask=" + mask);
  if (getAttr(el, "clip-path")) warn("已忽略剪裁路径 clip-path");
  const marker =
    getAttr(el, "marker-start") ??
    getAttr(el, "marker-mid") ??
    getAttr(el, "marker-end");
  if (marker) warn("已忽略 marker 标记 " + marker);
}

function convertElement(
  el: XmlElement,
  ctx: SvgStyleCtx,
  matrix: TransformMatrix,
  gradients: Map<string, RawGradient>,
  warnings: string[]
): ShapeBase[] {
  const tag = el.tagName.toLowerCase();
  if (DEF_TAGS.has(tag)) return [];
  if (getAttr(el, "display") === "none") return [];
  if (ctx.visibility === "hidden" || ctx.visibility === "collapse") return [];

  const warn = (msg: string) => {
    if (!warnings.includes(msg)) warnings.push(msg);
  };
  collectWarnings(el, warn);

  const m = multiply(matrix, parseTransform(getAttr(el, "transform")));
  const style = getStyle(el, ctx);
  const opacity = parseOpacity(getAttr(el, "opacity"));
  const name = getAttr(el, "id") ?? getAttr(el, "data-name");

  if (tag === "g") {
    const children: ShapeBase[] = [];
    for (const child of el.children) {
      children.push(...convertElement(child, style, m, gradients, warnings));
    }
    if (children.length === 0) return [];
    const bbox = computeBBox(children);
    if (!bbox) return [];
    const group = new GroupShape({
      x: bbox.x,
      y: bbox.y,
      width: bbox.width,
      height: bbox.height,
      opacity,
      name: name ?? "SVG 组",
    });
    for (const child of children) localizeShape(child, bbox.x, bbox.y);
    group.children = children;
    return [group];
  }

  const baseName = (fallback: string) => name ?? fallback;
  const dashArray = parseDashArray(getAttr(el, "stroke-dasharray"));

  if (tag === "rect") {
    const x = parseLength(getAttr(el, "x"));
    const y = parseLength(getAttr(el, "y"));
    const w = parseLength(getAttr(el, "width"));
    const h = parseLength(getAttr(el, "height"));
    if (w <= 0 || h <= 0) return [];
    const rx = parseLength(getAttr(el, "rx"), parseLength(getAttr(el, "ry")));
    const center = { x: x + w / 2, y: y + h / 2 };
    const decomposed = decomposeRotateScale(m);
    if (decomposed) {
      const c = transformPoint(m, center.x, center.y);
      const w2 = w * decomposed.sx;
      const h2 = h * decomposed.sy;
      const shape = new RectShape({
        x: c.x - w2 / 2,
        y: c.y - h2 / 2,
        width: w2,
        height: h2,
        rotation: decomposed.rotationDeg,
        cornerRadius: rx * Math.min(decomposed.sx, decomposed.sy),
        opacity,
        name: baseName("矩形"),
        dashArray,
      });
      const corners = [
        transformPoint(m, x, y),
        transformPoint(m, x + w, y),
        transformPoint(m, x + w, y + h),
        transformPoint(m, x, y + h),
      ];
      const bb = {
        x: Math.min(...corners.map((p) => p.x)),
        y: Math.min(...corners.map((p) => p.y)),
        width:
          Math.max(...corners.map((p) => p.x)) -
          Math.min(...corners.map((p) => p.x)),
        height:
          Math.max(...corners.map((p) => p.y)) -
          Math.min(...corners.map((p) => p.y)),
      };
      applyPaint(shape, style, gradients, bb, warn);
      shape.strokeWidth *= (decomposed.sx + decomposed.sy) / 2;
      return [shape];
    }
    const corners = [
      transformPoint(m, x, y),
      transformPoint(m, x + w, y),
      transformPoint(m, x + w, y + h),
      transformPoint(m, x, y + h),
    ];
    const d = "M " + corners.map((p) => p.x + " " + p.y).join(" L ") + " Z";
    const sx = Math.hypot(m.a, m.b);
    const sy = Math.hypot(m.c, m.d);
    return [
      finalizePath(
        d,
        style,
        gradients,
        opacity,
        baseName("矩形"),
        warn,
        dashArray,
        (sx + sy) / 2
      ),
    ];
  }

  if (tag === "circle" || tag === "ellipse") {
    const isCircle = tag === "circle";
    const rx = isCircle
      ? parseLength(getAttr(el, "r"))
      : parseLength(getAttr(el, "rx"));
    const ry = isCircle
      ? parseLength(getAttr(el, "r"))
      : parseLength(getAttr(el, "ry"));
    if (rx <= 0 || ry <= 0) return [];
    const cx = parseLength(getAttr(el, "cx"));
    const cy = parseLength(getAttr(el, "cy"));
    const decomposed = decomposeRotateScale(m);
    if (decomposed) {
      const c = transformPoint(m, cx, cy);
      const shape = new CircleShape({
        x: c.x - rx * decomposed.sx,
        y: c.y - ry * decomposed.sy,
        width: rx * 2 * decomposed.sx,
        height: ry * 2 * decomposed.sy,
        rotation: decomposed.rotationDeg,
        opacity,
        name: baseName(isCircle ? "圆形" : "椭圆"),
        dashArray,
      });
      const bb = getRotatedAABB(shape);
      applyPaint(shape, style, gradients, bb, warn);
      shape.strokeWidth *= (decomposed.sx + decomposed.sy) / 2;
      return [shape];
    }
    const d = transformPathDataMatrix(ellipsePath(cx, cy, rx, ry, 0), m);
    const sx = Math.hypot(m.a, m.b);
    const sy = Math.hypot(m.c, m.d);
    return [
      finalizePath(
        d,
        style,
        gradients,
        opacity,
        baseName(isCircle ? "圆形" : "椭圆"),
        warn,
        dashArray,
        (sx + sy) / 2
      ),
    ];
  }

  if (tag === "line") {
    const p1 = transformPoint(
      m,
      parseLength(getAttr(el, "x1")),
      parseLength(getAttr(el, "y1"))
    );
    const p2 = transformPoint(
      m,
      parseLength(getAttr(el, "x2")),
      parseLength(getAttr(el, "y2"))
    );
    if (Math.abs(p1.x - p2.x) < 1e-9 && Math.abs(p1.y - p2.y) < 1e-9) {
      return [];
    }
    const shape = new LineShape({
      startPoint: p1,
      endPoint: p2,
      opacity,
      name: baseName("直线"),
      dashArray,
    });
    const bb = shape.boundingBox;
    shape.startPoint = { x: p1.x - bb.x, y: p1.y - bb.y };
    shape.endPoint = { x: p2.x - bb.x, y: p2.y - bb.y };
    shape.x = bb.x;
    shape.y = bb.y;
    shape.width = bb.width;
    shape.height = bb.height;
    applyPaint(shape, style, gradients, bb, warn);
    const sx = Math.hypot(m.a, m.b);
    const sy = Math.hypot(m.c, m.d);
    shape.strokeWidth *= (sx + sy) / 2;
    return [shape];
  }

  if (tag === "polyline" || tag === "polygon") {
    const raw = parsePoints(getAttr(el, "points"));
    if (raw.length < 2) return [];
    const pts = raw.map((p) => transformPoint(m, p.x, p.y));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const bb: BoundingBox = {
      x: minX,
      y: minY,
      width: Math.max(...xs) - minX || 1,
      height: Math.max(...ys) - minY || 1,
    };
    const shape =
      tag === "polyline"
        ? new PolylineShape({
            points: pts.map((p) => ({ x: p.x - minX, y: p.y - minY })),
            opacity,
            name: baseName("折线"),
            dashArray,
          })
        : new PolygonShape({
            points: pts.map((p) => ({ x: p.x - minX, y: p.y - minY })),
            opacity,
            name: baseName("多边形"),
            dashArray,
          });
    shape.x = bb.x;
    shape.y = bb.y;
    shape.width = bb.width;
    shape.height = bb.height;
    applyPaint(shape, style, gradients, bb, warn);
    const sx = Math.hypot(m.a, m.b);
    const sy = Math.hypot(m.c, m.d);
    shape.strokeWidth *= (sx + sy) / 2;
    return [shape];
  }

  if (tag === "path") {
    const d = getAttr(el, "d");
    if (!d || d.trim() === "") return [];
    const transformed = transformPathDataMatrix(d, m);
    const sx = Math.hypot(m.a, m.b);
    const sy = Math.hypot(m.c, m.d);
    return [
      finalizePath(
        transformed,
        style,
        gradients,
        opacity,
        baseName("路径"),
        warn,
        dashArray,
        (sx + sy) / 2
      ),
    ];
  }

  if (tag === "text") {
    const text = collectText(el).trim();
    if (!text) return [];
    const p = transformPoint(
      m,
      parseLength(getAttr(el, "x")),
      parseLength(getAttr(el, "y"))
    );
    const sx = Math.hypot(m.a, m.b);
    const sy = Math.hypot(m.c, m.d);
    const fontScale = (sx + sy) / 2;
    const fontSize = style.fontSize * fontScale;
    const width = estimateTextWidth(text, fontSize);
    const height = fontSize * 1.2;
    const textAlign =
      style.textAnchor === "middle"
        ? "center"
        : style.textAnchor === "end"
          ? "right"
          : "left";
    const baseline = style.dominantBaseline.toLowerCase();
    let textBaseline: CanvasTextBaseline = "alphabetic";
    let y = p.y - height / 2;
    if (baseline === "middle" || baseline === "central") {
      textBaseline = "middle";
      y = p.y - height / 2;
    } else if (baseline === "hanging" || baseline === "text-before-edge") {
      textBaseline = "top";
      y = p.y;
    } else if (baseline === "text-after-edge") {
      textBaseline = "bottom";
      y = p.y - height;
    }
    const shape = new TextShape({
      x: p.x - width / 2,
      y,
      width,
      height,
      rotation: (Math.atan2(m.b, m.a) * 180) / Math.PI,
      text,
      fontSize,
      fontFamily: style.fontFamily,
      textAlign,
      textBaseline,
      opacity,
      name: baseName("文本"),
    });
    const bb = getRotatedAABB(shape);
    applyPaint(shape, style, gradients, bb, warn);
    return [shape];
  }

  if (tag === "image") {
    const href = getHref(el);
    if (!href) return [];
    if (!href.startsWith("data:image/")) {
      warn("已忽略外部图片引用（仅支持内嵌 data:image 图片）");
      return [];
    }
    const p = transformPoint(
      m,
      parseLength(getAttr(el, "x")),
      parseLength(getAttr(el, "y"))
    );
    const sx = Math.hypot(m.a, m.b);
    const sy = Math.hypot(m.c, m.d);
    const shape = new ImageShape({
      x: p.x,
      y: p.y,
      width: parseLength(getAttr(el, "width"), 100) * sx,
      height: parseLength(getAttr(el, "height"), 100) * sy,
      src: href,
      opacity,
      name: baseName("栅格图"),
    });
    return [shape];
  }

  warn("暂不支持 <" + el.tagName + "> 元素，已跳过");
  return [];
}

function convertChildren(
  el: XmlElement,
  ctx: SvgStyleCtx,
  matrix: TransformMatrix,
  gradients: Map<string, RawGradient>,
  warnings: string[]
): ShapeBase[] {
  const out: ShapeBase[] = [];
  for (const child of el.children) {
    out.push(...convertElement(child, ctx, matrix, gradients, warnings));
  }
  return out;
}

/**
 * 解析 SVG 文本并转换为编辑器图元。
 * - viewBox 用户单位按 1px = 1 逻辑像素处理；
 * - 默认按整体包围盒居中追加；
 * - 返回转换结果、警告与超出页面边界的图元列表。
 */
export function importSvg(
  svgText: string,
  options: SvgImportOptions
): SvgImportResult {
  const warnings: string[] = [];
  const root = parseXml(svgText);
  if (root.tagName.toLowerCase() !== "svg") {
    throw new Error("不是有效的 SVG 文件（缺少 <svg> 根元素）");
  }
  const gradients = collectGradients(root);
  const shapes = convertChildren(
    root,
    DEFAULT_STYLE,
    IDENTITY,
    gradients,
    warnings
  );
  shapes.forEach((s, i) => {
    s.zIndex = i;
  });

  let bbox = computeBBox(shapes);
  if (options.center !== false && bbox && shapes.length > 0) {
    const dx = options.pageWidth / 2 - (bbox.x + bbox.width / 2);
    const dy = options.pageHeight / 2 - (bbox.y + bbox.height / 2);
    for (const s of shapes) translateShape(s, dx, dy);
    bbox = computeBBox(shapes);
  }

  const outOfBounds: OutOfBoundsShape[] = [];
  for (const s of shapes) {
    const bb = getRotatedAABB(s);
    if (
      bb.x < 0 ||
      bb.y < 0 ||
      bb.x + bb.width > options.pageWidth ||
      bb.y + bb.height > options.pageHeight
    ) {
      outOfBounds.push({ id: s.id, name: s.name, bbox: bb });
    }
  }

  return { shapes, warnings, outOfBounds, bbox };
}
